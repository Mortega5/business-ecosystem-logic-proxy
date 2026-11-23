import { isDeepStrictEqual } from 'node:util';
import { Injectable, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { BadGatewayError, DomainError, ForbiddenError } from '../../common/domain-error';
import { AppConfigService } from '../../config/app-config.service';
import type { UpstreamName } from '../../config/upstream-names';
import { ChargingAssets } from '../charging-assets';
import { AS_JSON } from '../http-options';
import { OwnedResources } from '../owned-resources';
import { isRecord, isRelatedAs } from '../related-party';
import { isResourceId } from '../resource-id.pipe';
import { pagination, queryParams } from '../schemas/pagination';
import { parseRequest } from '../schemas/parse';
import { SellerParties } from '../seller-parties';
import { parseJson, Specifications, type SpecificationApi, type Undo } from '../specification/specifications';
import { TmfProxy } from '../tmf-proxy';
import { hasInvalidProfilePicture } from './launch-requirements';
import { orchestrationPlanProblem } from './orchestration-plan';
import { PriceReferences } from './price-references';
import { isDigital, removedCharacteristicIds, sameCustomCharacteristics, upgradeOf, validCharacteristics } from './product-rules';

type Json = Record<string, unknown>;

// More bundled products than anybody puts together by hand; each one is a request to the API
const MAX_BUNDLED = 50;
// What the list of the ids may carry; any other filter would show what its owner has not published
const idsQuery = z.strictObject({ id: z.string(), ...pagination });
const LIST_FILTERS = new Set(Object.keys(idsQuery.shape));
const PAGE = 100;

const PRODUCT: SpecificationApi = {
    upstream: 'tmforum.catalog',
    collection: 'productSpecification',
    noun: 'Product spec',
    dependents: { upstream: 'tmforum.catalog', path: '/productOffering', field: 'productSpecification.id', noun: 'offerings' },
    messages: {
        list: 'You are not authorized to list the product specs',
        read: 'Unauthorized to retrieve a product spec that is not launched',
        create: 'You are not authorized to create resources',
        notOwner: 'The user making the request and the specified owner are not the same user',
        update: 'The user making the request is not the owner of the accessed resource',
        missing: 'The required resource does not exist',
        retireInUse: (inUse) => `All the attached offerings must be retired or obsolete to retire a product (blocked by offerings ${inUse.map((offering) => String(offering['id'])).join(', ')})`
    }
};

// The specifications that a product has to wait for before it is launched
const DEPENDENCIES: { field: string; upstream: UpstreamName; collection: string; noun: string }[] = [
    { field: 'serviceSpecification', upstream: 'tmforum.service', collection: 'serviceSpecification', noun: 'service' },
    { field: 'resourceSpecification', upstream: 'tmforum.resource', collection: 'resourceSpecification', noun: 'resource' }
];

const statusOf = (value: unknown): string => (typeof value === 'string' ? value.toLowerCase() : '');

const idsOf = (references: unknown): string[] => (Array.isArray(references) ? (references as unknown[]).flatMap((one) => (isRecord(one) && typeof one['id'] === 'string' ? [one['id']] : [])) : []);

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : 'unknown error');

/**
 * The product specifications a seller owns. What a product is made of is checked before it is stored: its characteristics and, for a
 * bundle, the products in it, which have to be the seller's and not bundles. The charging backend checks a product before it is made
 * and is told after it was made, and the same for a new version of a digital product, which is the only change to its asset; when it
 * cannot be told, or what depends on the product cannot be updated, the client is told what is left. A product is launched once the
 * service and resource specifications that it is made of are, and retired or made obsolete once its offerings are.
 */
@Injectable()
export class ProductSpecifications extends Specifications {
    private readonly log = new Logger(ProductSpecifications.name);

    constructor(
        proxy: TmfProxy,
        owned: OwnedResources,
        config: AppConfigService,
        sellers: SellerParties,
        private readonly charging: ChargingAssets,
        private readonly prices: PriceReferences
    ) {
        super(proxy, owned, config, sellers, PRODUCT);
    }

    /** The seller's own products; when it is the products with some ids that are asked for, the ones that anybody may read or that are theirs. */
    override async list(req: Request, res: Response): Promise<void> {
        const filters = Object.keys(req.query);
        const ids = req.query['id'];
        if (typeof ids !== 'string' || filters.some((name) => !LIST_FILTERS.has(name))) {
            return super.list(req, res);
        }
        const wanted = ids.split(',');
        if (wanted.length > PAGE || !wanted.every(isResourceId)) {
            throw new DomainError('Invalid query', 400);
        }
        const params = queryParams(req.query, parseRequest(idsQuery, req.query, 'Invalid query'));
        const response = await this.proxy.send(req, { upstream: this.api.upstream, path: `/${this.api.collection}`, method: 'GET', search: `?${params.toString()}` });
        const found = parseJson(response.body);
        if (response.status >= 400 || !Array.isArray(found)) {
            this.proxy.reply(res, response);
            return;
        }
        const shown = (found as unknown[]).filter((one) => isRecord(one) && this.visibility(req, one) !== 'nobody');
        const counted = response.headers.has('x-total-count') ? { 'x-total-count': String(shown.length) } : {};
        this.proxy.reply(res, { ...response, body: JSON.stringify(shown) }, counted);
    }

    protected override async beforeCreate(req: Request, product: Json): Promise<Undo | undefined> {
        product['validFor'] ??= { startDateTime: new Date().toISOString() };
        await this.assertValid(req, product, null);
        await this.charging.validateProduct(req, product);
        return async () => {
            try {
                await this.charging.rollbackProduct(req, product);
                return undefined;
            } catch (error) {
                return `the charging backend could not be told that the product was not made (${reasonOf(error)})`;
            }
        };
    }

    /** The charging backend is told the product was made; if it cannot be, the product is retired and taken back, so that nobody can buy what it does not know. */
    protected override async afterCreate(req: Request, created: Json): Promise<void> {
        try {
            await this.charging.attachProduct(req, created);
        } catch (error) {
            const id = String(created['id']);
            const left = await this.takenBack(req, id, created);
            throw new BadGatewayError(`The product spec ${id} was created and the charging backend could not be told (${reasonOf(error)}); ${left}`);
        }
    }

    private async takenBack(req: Request, id: string, created: Json): Promise<string> {
        let retired = false;
        try {
            const response = await this.proxy.send(req, { upstream: this.api.upstream, path: this.path(id), method: 'PATCH', body: JSON.stringify({ lifecycleStatus: 'Retired' }), ...AS_JSON, search: '' });
            retired = response.status < 400;
        } catch {
            // The same as an answer that refuses it
        }
        let rolledBack = false;
        try {
            await this.charging.rollbackProduct(req, created);
            rolledBack = true;
        } catch {
            // Said below
        }
        this.log.warn(`The product spec ${id} could not be told to the charging backend: ${retired ? 'it was retired' : 'it could not be retired'}, and ${rolledBack ? 'the backend was told to take it back' : 'the backend could not be told to take it back'}`);
        const left = [retired ? undefined : 'it could not be retired and has to be retired by hand', rolledBack ? undefined : 'the charging backend could not be told to take it back'].filter((one) => one !== undefined);
        return left.length === 0 ? 'it was retired' : left.join(' and ');
    }

    protected override async beforeUpdate(req: Request, id: string, current: Json, changes: Json): Promise<Undo | undefined> {
        if (!current['validFor'] && !changes['validFor']) {
            changes['validFor'] = { startDateTime: new Date().toISOString() };
        }
        const status = statusOf(changes['lifecycleStatus']);
        if (status === 'obsolete' && statusOf(current['lifecycleStatus']) !== 'obsolete') {
            await this.assertOfferingsObsolete(req, id);
        }
        const removed = removedCharacteristicIds(current, changes);
        if (removed.length > 0 && statusOf(current['lifecycleStatus']) !== 'active') {
            throw new DomainError('Product specification characteristics can only be removed from active product specifications', 422);
        }
        if ((changes['isBundle'] || changes['bundledProductSpecification']) && statusOf(current['lifecycleStatus']) !== 'active') {
            throw new DomainError('It is not allowed to update bundle related attributes (isBundle, bundledProductSpecification) in launched products', 422);
        }
        if (statusOf(current['lifecycleStatus']) !== 'launched' && status === 'launched') {
            await this.assertDependenciesLaunched(req, current, changes);
        }
        this.assertUpgradeAllowed(current, changes);
        await this.assertValid(req, changes, Array.isArray(current['productSpecCharacteristic']) ? (current['productSpecCharacteristic'] as unknown[]) : []);
        const upgrade = upgradeOf(current, changes);
        if (upgrade === undefined) {
            return undefined;
        }
        await this.charging.validateProductUpgrade(req, upgrade);
        return async () => {
            try {
                await this.charging.rollbackProductUpgrade(req, upgrade);
                return undefined;
            } catch (error) {
                return `the charging backend could not be told that the product ${id} was not upgraded (${reasonOf(error)})`;
            }
        };
    }

    protected override prepareUpdate(current: Json, changes: Json): { changes: Json; after?: (req: Request) => Promise<void> } {
        const removed = removedCharacteristicIds(current, changes);
        const upgrade = upgradeOf(current, changes);
        if (removed.length === 0 && upgrade === undefined) {
            return { changes };
        }
        const id = String(current['id']);
        return {
            changes,
            // The charging backend takes back an upgrade that it is not told of in 15 seconds, so it is told first
            after: async (req) => {
                if (upgrade !== undefined) {
                    await this.upgradeTold(req, id, current, upgrade);
                }
                if (removed.length > 0) {
                    try {
                        await this.prices.remove(req, id, removed);
                    } catch (error) {
                        throw new BadGatewayError(`The product spec ${id} was changed and ${reasonOf(error).replace(/^The /, 'the ')}`);
                    }
                }
            }
        };
    }

    /** The charging backend is told the new version is made; if it cannot be, the product goes back to the version of its asset, which is the one the backend keeps. */
    private async upgradeTold(req: Request, id: string, current: Json, upgrade: { id: string; version: unknown; productSpecCharacteristic: unknown }): Promise<void> {
        try {
            await this.charging.attachProductUpgrade(req, upgrade);
            return;
        } catch (error) {
            const reason = reasonOf(error);
            let back = 'the previous version could not be restored and has to be restored by hand';
            try {
                const response = await this.proxy.send(req, {
                    upstream: this.api.upstream,
                    path: this.path(id),
                    method: 'PATCH',
                    body: JSON.stringify({ version: current['version'], productSpecCharacteristic: current['productSpecCharacteristic'] }),
                    ...AS_JSON,
                    search: ''
                });
                if (response.status < 400) {
                    back = 'the previous version was restored';
                }
            } catch {
                // Said in the answer
            }
            try {
                await this.charging.rollbackProductUpgrade(req, upgrade);
            } catch {
                // The backend takes the upgrade back by itself when its time is over
            }
            this.log.warn(`The upgrade of the product spec ${id} could not be told to the charging backend: ${back}`);
            throw new BadGatewayError(`The product spec ${id} was upgraded and the charging backend could not be told (${reason}); ${back}`);
        }
    }

    // ---- What a product has to be

    /** The characteristics, the picture, the plan and the bundle of what the seller sends; `previous` is what the product has now, nothing when it is made. */
    private async assertValid(req: Request, product: Json, previous: unknown[] | null): Promise<void> {
        if (hasInvalidProfilePicture(product)) {
            throw new DomainError('Product profile picture must use a valid image format (SVG, PNG, JPEG or GIF)', 422);
        }
        if (product['productSpecCharacteristic'] && !validCharacteristics(product['productSpecCharacteristic'], previous)) {
            throw new DomainError('Invalid product spec characteristics', 422);
        }
        const problem = orchestrationPlanProblem(product['orchestrationPlan']);
        if (problem !== undefined) {
            throw new DomainError(problem, 422);
        }
        if (product['isBundle']) {
            await this.assertBundle(req, product);
        }
    }

    private async assertBundle(req: Request, product: Json): Promise<void> {
        const bundled = product['bundledProductSpecification'];
        if (!Array.isArray(bundled) || bundled.length < 2) {
            throw new DomainError('Product spec bundles must contain at least two bundled product specs', 422);
        }
        if (bundled.length > MAX_BUNDLED) {
            throw new DomainError(`Product spec bundles cannot contain more than ${MAX_BUNDLED} product specs`, 422);
        }
        const partyId = (req as Request & { user?: { partyId?: string } }).user?.partyId ?? '';
        for (const reference of bundled as unknown[]) {
            if (!isRecord(reference) || !reference['href']) {
                throw new DomainError('Missing required field href in bundleProductSpecification', 422);
            }
            const id = reference['id'];
            const unreadable = new DomainError('The attached product cannot be read or does not exist', 422);
            if (typeof id !== 'string' || !isResourceId(id)) {
                throw unreadable;
            }
            const response = await this.proxy.send(req, { upstream: this.api.upstream, path: this.path(id), method: 'GET', search: '' });
            const found = parseJson(response.body);
            if (response.status >= 400 || !isRecord(found)) {
                throw unreadable;
            }
            if (!isRelatedAs(found, partyId, this.config.auth.roles.seller)) {
                throw new ForbiddenError(`You are not authorized to include the product spec ${id} in a product spec bundle`);
            }
            if (found['isBundle']) {
                throw new DomainError('It is not possible to include a product spec bundle in another product spec bundle', 422);
            }
            if (found['lifecycleStatus'] && !['active', 'launched'].includes(statusOf(found['lifecycleStatus']))) {
                throw new DomainError('Only Active or Launched product specs can be included in a bundle', 422);
            }
        }
    }

    /** What changes of a digital product, whose asset is behind it: only a new version brings new asset information, and nothing else changes in it. */
    private assertUpgradeAllowed(current: Json, changes: Json): void {
        if (!isDigital(current['productSpecCharacteristic'])) {
            return;
        }
        const version = changes['version'];
        const chars = changes['productSpecCharacteristic'];
        const sameVersion = Boolean(version) && JSON.stringify(version) === JSON.stringify(current['version']);
        if (version && !isDigital(chars) && !sameVersion) {
            throw new DomainError('To upgrade product specifications it is required to provide new asset info', 422);
        }
        if (sameVersion || (version === undefined && chars && !isDeepStrictEqual(chars, current['productSpecCharacteristic']))) {
            throw new DomainError('Product specification characteristics only can be updated for upgrading digital products', 422);
        }
        if (version && isDigital(chars) && !sameCustomCharacteristics(chars, current['productSpecCharacteristic'])) {
            throw new DomainError('It is not allowed to update custom characteristics during a product upgrade', 422);
        }
    }

    /** A product is launched only when the service and the resource specifications that it is made of are. */
    private async assertDependenciesLaunched(req: Request, current: Json, changes: Json): Promise<void> {
        for (const dependency of DEPENDENCIES) {
            const ids = [...new Set(idsOf(changes[dependency.field] ?? current[dependency.field]))];
            if (ids.length === 0) {
                continue;
            }
            const failure = new DomainError(`Error getting ${dependency.noun} specification through the API`, 400);
            if (!ids.every(isResourceId)) {
                throw failure;
            }
            const search = ids.length === 1 ? '?fields=lifecycleStatus' : `?id=${ids.map(encodeURIComponent).join(',')}&fields=lifecycleStatus&limit=${ids.length}`;
            const path = ids.length === 1 ? `/${dependency.collection}/${encodeURIComponent(ids[0] ?? '')}` : `/${dependency.collection}`;
            const response = await this.proxy.send(req, { upstream: dependency.upstream, path, method: 'GET', search });
            const body = parseJson(response.body);
            const found = Array.isArray(body) ? (body as unknown[]) : isRecord(body) ? [body] : [];
            if (response.status >= 400 || found.length !== ids.length) {
                throw failure;
            }
            if (!found.every((one) => isRecord(one) && statusOf(one['lifecycleStatus']) === 'launched')) {
                throw new DomainError(`It is not allowed to launch a product spec without launching ${dependency.noun} spec previously`, 409);
            }
        }
    }

    /** A product is made obsolete only when all its offerings are. */
    private async assertOfferingsObsolete(req: Request, id: string): Promise<void> {
        for (let page = 0; page < this.config.limits.readAll.maxPages; page += 1) {
            const search = `?productSpecification.id=${encodeURIComponent(id)}&fields=lifecycleStatus&limit=${PAGE}&offset=${page * PAGE}`;
            const response = await this.proxy.send(req, { upstream: 'tmforum.catalog', path: '/productOffering', method: 'GET', search });
            const found = parseJson(response.body);
            if (response.status >= 400 || !Array.isArray(found)) {
                throw new BadGatewayError('The offerings of the product spec could not be read');
            }
            const pending = (found as unknown[]).filter((one) => !isRecord(one) || statusOf(one['lifecycleStatus']) !== 'obsolete');
            if (pending.length > 0) {
                throw new DomainError('All the attached offerings must be obsolete to make a product obsolete', 409);
            }
            if (found.length < PAGE) {
                return;
            }
        }
        throw new BadGatewayError('The offerings of the product spec could not be read');
    }
}
