import type { Request, Response } from 'express';
import { BadGatewayError, DomainError, ForbiddenError, NotFoundError } from '../../common/domain-error';
import { AppConfigService } from '../../config/app-config.service';
import type { UpstreamName } from '../../config/upstream-names';
import { OwnedResources } from '../owned-resources';
import { callerParty, isOwnedOnlyBy, isRecord, isRelatedAs } from '../related-party';
import { SellerParties } from '../seller-parties';
import { TmfProxy } from '../tmf-proxy';
import type { UpstreamUser } from '../upstream-headers';
import { isInUse, isRetired, isValidStatusTransition, sameRelatedParties, validateNameAndDescription } from './specification-rules';

/** What differs between the APIs whose specifications a seller owns: where they are, how the catalog names them, and what v11 said. */
export interface SpecificationApi {
    upstream: UpstreamName;
    /** The collection of the API, `resourceSpecification`. */
    collection: string;
    /** The field of a product specification that names the specification, to know what still uses it. */
    productSpecificationField: string;
    /** What it is called in a refusal about its name or description, such as `Resource spec`. */
    noun: string;
    messages: {
        list: string;
        read: string;
        create: string;
        update: string;
        missing: string;
        retireInUse: string;
    };
}

const PRODUCT_SPECIFICATIONS_PAGE = 100;
const MAX_PAGES = 50;

// What anybody may read; a specification in any other state, a draft, is for its owner
const PUBLIC_STATUSES = ['launched', 'retired', 'obsolete'];

const shown = (value: unknown): string => (typeof value === 'string' ? value : JSON.stringify(value));

const parseObject = (body: string): Record<string, unknown> => {
    const parsed: unknown = JSON.parse(body);
    if (!isRecord(parsed)) {
        throw new DomainError('Invalid body', 400);
    }
    return parsed;
};

const parseJson = (text: string): unknown => {
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
};

/**
 * The specifications of an API where a seller owns them: the list is the caller's own, one is read by anybody once it is not a
 * draft, it is created and changed only by a seller who owns it, and a retirement, by a change or a delete, waits until every
 * product specification that uses it is retired.
 */
export class Specifications {
    constructor(
        private readonly proxy: TmfProxy,
        private readonly owned: OwnedResources,
        private readonly config: AppConfigService,
        private readonly sellers: SellerParties,
        private readonly api: SpecificationApi
    ) {}

    private path(id: string): string {
        return `/${this.api.collection}/${encodeURIComponent(id)}`;
    }

    private unreadable(): BadGatewayError {
        return new BadGatewayError(`The ${this.api.noun.toLowerCase()} could not be read`);
    }

    private isSeller(req: Request): boolean {
        const seller = this.config.auth.roles.seller.toLowerCase();
        return ((req as Request & { user?: UpstreamUser }).user?.roles ?? []).some((role) => role.name.toLowerCase() === seller);
    }

    list(req: Request, res: Response): Promise<void> {
        return this.owned.list(req, res, { upstream: this.api.upstream, path: `/${this.api.collection}`, role: 'seller', refusal: this.api.messages.list });
    }

    async read(req: Request, res: Response, id: string): Promise<void> {
        const response = await this.proxy.send(req, { upstream: this.api.upstream, path: this.path(id), search: '' });
        const forEverybody = response.status >= 400 || this.assertReadable(req, response.body);
        this.proxy.reply(res, response, forEverybody ? {} : { 'cache-control': 'private, no-store' });
    }

    create(req: Request, res: Response, body: string): Promise<void> {
        const { id: _id, href: _href, ...specification } = parseObject(body);
        if (!this.isSeller(req) || !isOwnedOnlyBy(specification, callerParty(req, this.api.messages.create), this.config.auth.roles.seller)) {
            throw new ForbiddenError(this.api.messages.create);
        }
        validateNameAndDescription(specification, this.api.noun, true);
        const [seller] = specification['relatedParty'] as Record<string, unknown>[];
        specification['relatedParty'] = this.sellers.of(seller as Record<string, unknown>, (req as Request & { user: UpstreamUser }).user);
        return this.proxy.forward(req, res, { upstream: this.api.upstream, path: `/${this.api.collection}`, body: JSON.stringify(specification) });
    }

    async update(req: Request, res: Response, id: string, body: string): Promise<void> {
        const changes = parseObject(body);
        const current = await this.owner(req, id);
        if ('relatedParty' in changes && !sameRelatedParties(current['relatedParty'], changes['relatedParty'])) {
            throw new DomainError('The field "relatedParty" can not be modified', 409);
        }
        const status = changes['lifecycleStatus'];
        if (status !== undefined && status !== null) {
            if (!isValidStatusTransition(current['lifecycleStatus'], status)) {
                throw new DomainError(`Cannot transition from lifecycle status ${shown(current['lifecycleStatus'])} to ${shown(status)}`, 400);
            }
            if (!isRetired(current['lifecycleStatus']) && isRetired(status)) {
                await this.assertNotInUse(req, id);
            }
        }
        validateNameAndDescription(changes, this.api.noun, false);
        await this.proxy.forward(req, res, { upstream: this.api.upstream, path: this.path(id), body: JSON.stringify(changes) });
    }

    /** A delete retires the specification, which stays in the catalog. */
    async retire(req: Request, res: Response, id: string): Promise<void> {
        const current = await this.owner(req, id);
        if (!isInUse(current)) {
            throw new DomainError('The resource is already retired', 409);
        }
        await this.assertNotInUse(req, id);
        await this.proxy.forward(req, res, {
            upstream: this.api.upstream,
            path: this.path(id),
            method: 'PATCH',
            body: JSON.stringify({ lifecycleStatus: 'Retired' }),
            contentType: 'application/json'
        });
    }

    /** Whether anybody may have it, or only its owner, which is a thing a cache in between must not repeat to the others. */
    private assertReadable(req: Request, body: string): boolean {
        const specification = parseJson(body);
        if (!isRecord(specification)) {
            throw this.unreadable();
        }
        const status = specification['lifecycleStatus'];
        const partyId = (req as Request & { user?: UpstreamUser }).user?.partyId;
        if (typeof status === 'string' && PUBLIC_STATUSES.includes(status.toLowerCase())) {
            return true;
        }
        if (typeof partyId === 'string' && isRelatedAs(specification, partyId, this.config.auth.roles.seller)) {
            return false;
        }
        throw new ForbiddenError(this.api.messages.read);
    }

    /** The specification as the API has it, for a seller who owns it. */
    private async owner(req: Request, id: string): Promise<Record<string, unknown>> {
        const partyId = callerParty(req, this.api.messages.update);
        if (!this.isSeller(req)) {
            throw new ForbiddenError(this.api.messages.update);
        }
        const response = await this.proxy.send(req, { upstream: this.api.upstream, path: this.path(id), method: 'GET', search: '' });
        if (response.status === 404) {
            throw new NotFoundError(this.api.messages.missing);
        }
        const current = parseJson(response.body);
        if (response.status >= 400 || !isRecord(current)) {
            throw this.unreadable();
        }
        if (!isRelatedAs(current, partyId, this.config.auth.roles.seller)) {
            throw new ForbiddenError(this.api.messages.update);
        }
        return current;
    }

    private async assertNotInUse(req: Request, id: string): Promise<void> {
        for (let page = 0; page < MAX_PAGES; page += 1) {
            const search = `?${this.api.productSpecificationField}=${encodeURIComponent(id)}&fields=lifecycleStatus&limit=${PRODUCT_SPECIFICATIONS_PAGE}&offset=${page * PRODUCT_SPECIFICATIONS_PAGE}`;
            const response = await this.proxy.send(req, { upstream: 'tmforum.catalog', path: '/productSpecification', method: 'GET', search });
            const specifications = parseJson(response.body);
            if (response.status >= 400 || !Array.isArray(specifications)) {
                throw new BadGatewayError(`The product specs of the ${this.api.noun.toLowerCase()} could not be read`);
            }
            if (specifications.some(isInUse)) {
                throw new DomainError(this.api.messages.retireInUse, 409);
            }
            if (specifications.length < PRODUCT_SPECIFICATIONS_PAGE) {
                return;
            }
        }
        throw new BadGatewayError(`The product specs of the ${this.api.noun.toLowerCase()} could not be read`);
    }
}
