import type { Request, Response } from 'express';
import { BadGatewayError, DomainError, ForbiddenError, NotFoundError } from '../../common/domain-error';
import { AppConfigService } from '../../config/app-config.service';
import type { UpstreamName } from '../../config/upstream-names';
import type { UpstreamResponse } from '../../http-client/upstream-client';
import { AS_JSON, PRIVATE } from '../http-options';
import { OwnedResources } from '../owned-resources';
import { callerParty, isOwnedOnlyBy, isRecord, isRelatedAs } from '../related-party';
import { SellerParties } from '../seller-parties';
import { TmfProxy, type ProxyTarget } from '../tmf-proxy';
import type { UpstreamUser } from '../upstream-headers';
import { isInUse, isRetired, isValidStatusTransition, sameRelatedParties, validateNameAndDescription } from './specification-rules';

/** What differs between the APIs whose specifications a seller owns: where they are, what still uses them, and what v11 said. */
export interface SpecificationApi {
    upstream: UpstreamName;
    /** The collection of the API, `resourceSpecification`. */
    collection: string;
    /** What it is called in a refusal about its name or description, such as `Resource spec`. */
    noun: string;
    /** Whether it is read only by its owner, whatever its state; what has the deployment of a product in it is. */
    privateReads?: boolean;
    /** What still uses a specification, which has to be retired before it; nothing when it can be retired at once. */
    dependents?: {
        upstream: UpstreamName;
        path: string;
        /** The field that names the specification in what uses it. */
        field: string;
        /** What they are called, such as `product specs`. */
        noun: string;
    };
    messages: {
        list: string;
        read: string;
        create: string;
        update: string;
        missing: string;
        retireInUse: (inUse: Record<string, unknown>[]) => string;
    };
}

/** Takes back what was done before a step that failed; what it returns, when there is something, is what it could not take back. */
export type Undo = () => Promise<string | undefined>;

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

export const parseJson = (text: string): unknown => {
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
};

/**
 * The specifications of an API where a seller owns them: the list is the caller's own, one is read by anybody once it is not a
 * draft, it is created and changed only by a seller who owns it, and a retirement, by a change or a delete, waits until what uses
 * it is retired. An API that does more than keep them extends this and takes the steps it needs; a step that comes after another
 * that made something elsewhere takes it back when it fails.
 */
export class Specifications {
    constructor(
        protected readonly proxy: TmfProxy,
        private readonly owned: OwnedResources,
        protected readonly config: AppConfigService,
        protected readonly sellers: SellerParties,
        protected readonly api: SpecificationApi
    ) {}

    /** Further checks of what a seller sends, on a create and on a change. */
    protected validate(_specification: Record<string, unknown>): void {
        // None by default
    }

    /** Before a create is sent: it may change the specification, and give what undoes what it made if the create fails. */
    protected beforeCreate(_req: Request, _specification: Record<string, unknown>): Promise<Undo | undefined> {
        return Promise.resolve(undefined);
    }

    /** Once what the seller sends is valid and before a change is sent: checks that need to ask elsewhere. */
    protected beforeUpdate(_req: Request, _id: string, _current: Record<string, unknown>, _changes: Record<string, unknown>): Promise<void> {
        return Promise.resolve();
    }

    /** Before a change is sent: the changes that go on, and what is done once the change has been made. */
    protected prepareUpdate(
        _current: Record<string, unknown>,
        changes: Record<string, unknown>
    ): { changes: Record<string, unknown>; after?: (req: Request) => Promise<void> } {
        return { changes };
    }

    /** Before a specification is retired: it may give what undoes what it made if the retirement fails. */
    protected beforeRetire(_req: Request, _current: Record<string, unknown>): Promise<Undo | undefined> {
        return Promise.resolve(undefined);
    }

    protected path(id: string): string {
        return `/${this.api.collection}/${encodeURIComponent(id)}`;
    }

    private unreadable(): BadGatewayError {
        return new BadGatewayError(`The ${this.api.noun.toLowerCase()} could not be read`);
    }

    protected isSeller(req: Request): boolean {
        const seller = this.config.auth.roles.seller.toLowerCase();
        return ((req as Request & { user?: UpstreamUser }).user?.roles ?? []).some((role) => role.name.toLowerCase() === seller);
    }

    list(req: Request, res: Response): Promise<void> {
        return this.owned.list(req, res, { upstream: this.api.upstream, path: `/${this.api.collection}`, role: 'seller', refusal: this.api.messages.list });
    }

    async read(req: Request, res: Response, id: string): Promise<void> {
        const response = await this.proxy.send(req, { upstream: this.api.upstream, path: this.path(id), search: '' });
        const forEverybody = response.status >= 400 || this.assertReadable(req, response.body);
        this.proxy.reply(res, response, forEverybody ? {} : PRIVATE);
    }

    async create(req: Request, res: Response, body: string): Promise<void> {
        const { id: _id, href: _href, ...specification } = parseObject(body);
        if (!this.isSeller(req) || !isOwnedOnlyBy(specification, callerParty(req, this.api.messages.create), this.config.auth.roles.seller)) {
            throw new ForbiddenError(this.api.messages.create);
        }
        validateNameAndDescription(specification, this.api.noun, true, this.config.limits);
        this.validate(specification);
        const undo = await this.beforeCreate(req, specification);
        const [seller] = specification['relatedParty'] as Record<string, unknown>[];
        specification['relatedParty'] = this.sellers.of(seller as Record<string, unknown>, (req as Request & { user: UpstreamUser }).user);
        const response = await this.sendOrUndo(
            req,
            { upstream: this.api.upstream, path: `/${this.api.collection}`, body: JSON.stringify(specification), ...AS_JSON },
            undo,
            `The ${this.api.noun.toLowerCase()} could not be created`
        );
        this.proxy.reply(res, response);
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
        validateNameAndDescription(changes, this.api.noun, false, this.config.limits);
        this.validate(changes);
        await this.beforeUpdate(req, id, current, changes);
        const { changes: sent, after } = this.prepareUpdate(current, changes);
        const response = await this.proxy.send(req, { upstream: this.api.upstream, path: this.path(id), body: JSON.stringify(sent), ...AS_JSON });
        if (response.status < 400) {
            await after?.(req);
        }
        this.proxy.reply(res, response);
    }

    /** A delete retires the specification, which stays in the catalog. */
    async retire(req: Request, res: Response, id: string): Promise<void> {
        const current = await this.owner(req, id);
        if (!isInUse(current)) {
            throw new DomainError('The resource is already retired', 409);
        }
        await this.assertNotInUse(req, id);
        const undo = await this.beforeRetire(req, current);
        const response = await this.sendOrUndo(
            req,
            { upstream: this.api.upstream, path: this.path(id), method: 'PATCH', body: JSON.stringify({ lifecycleStatus: 'Retired' }), ...AS_JSON },
            undo,
            `The ${this.api.noun.toLowerCase()} could not be retired`
        );
        this.proxy.reply(res, response);
    }

    /** Sends a step, and when it fails takes back what the steps before it made; if that cannot be done the client is told what is left. */
    private async sendOrUndo(req: Request, target: ProxyTarget, undo: Undo | undefined, failure: string): Promise<UpstreamResponse> {
        let response: UpstreamResponse;
        try {
            response = await this.proxy.send(req, target);
        } catch (error) {
            await this.undone(undo, failure);
            throw error;
        }
        if (response.status >= 400) {
            await this.undone(undo, failure);
        }
        return response;
    }

    private async undone(undo: Undo | undefined, failure: string): Promise<void> {
        const left = await undo?.();
        if (left !== undefined) {
            throw new BadGatewayError(`${failure} and ${left}`);
        }
    }

    private assertReadable(req: Request, body: string): boolean {
        const specification = parseJson(body);
        if (!isRecord(specification)) {
            throw this.unreadable();
        }
        const status = specification['lifecycleStatus'];
        const partyId = (req as Request & { user?: UpstreamUser }).user?.partyId;
        if (this.api.privateReads !== true && typeof status === 'string' && PUBLIC_STATUSES.includes(status.toLowerCase())) {
            return true;
        }
        if (typeof partyId === 'string' && isRelatedAs(specification, partyId, this.config.auth.roles.seller)) {
            return false;
        }
        throw new ForbiddenError(this.api.messages.read);
    }

    /** The specification as the API has it, for a seller who owns it. */
    protected async owner(req: Request, id: string): Promise<Record<string, unknown>> {
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

    /** The filter that finds what uses the specification, or nothing when nothing can; by default what names it in `field`. */
    protected dependentsFilter(_req: Request, id: string): Promise<string | undefined> {
        return Promise.resolve(`${this.api.dependents?.field ?? ''}=${encodeURIComponent(id)}`);
    }

    protected async assertNotInUse(req: Request, id: string): Promise<void> {
        const { dependents } = this.api;
        if (dependents === undefined) {
            return;
        }
        const filter = await this.dependentsFilter(req, id);
        if (filter === undefined) {
            return;
        }
        const { pageSize, maxPages } = this.config.limits.readAll;
        for (let page = 0; page < maxPages; page += 1) {
            const search = `?${filter}&fields=lifecycleStatus&limit=${pageSize}&offset=${page * pageSize}`;
            const response = await this.proxy.send(req, { upstream: dependents.upstream, path: dependents.path, method: 'GET', search });
            const found = parseJson(response.body);
            if (response.status >= 400 || !Array.isArray(found)) {
                throw new BadGatewayError(`The ${dependents.noun} of the ${this.api.noun.toLowerCase()} could not be read`);
            }
            const inUse = (found as unknown[]).filter(isInUse) as Record<string, unknown>[];
            if (inUse.length > 0) {
                throw new DomainError(this.api.messages.retireInUse(inUse), 409);
            }
            if (found.length < pageSize) {
                return;
            }
        }
        throw new BadGatewayError(`The ${dependents.noun} of the ${this.api.noun.toLowerCase()} could not be read`);
    }
}
