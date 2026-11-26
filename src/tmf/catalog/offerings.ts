import { isDeepStrictEqual } from 'node:util';
import { Injectable, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { pagination, queryParams, sorting } from '../schemas/pagination';
import { parseRequest } from '../schemas/parse';
import { BadGatewayError, DomainError, ForbiddenError, NotFoundError } from '../../common/domain-error';
import { AppConfigService } from '../../config/app-config.service';
import { OperatorService } from '../../operator/operator.service';
import { ChargingAssets } from '../charging-assets';
import { AS_JSON, PRIVATE } from '../http-options';
import { callerParty, isRecord, isRelatedAs } from '../related-party';
import { isResourceId } from '../resource-id.pipe';
import { isRetired, isValidStatusTransition, sameRelatedParties, validateNameAndDescription } from '../specification/specification-rules';
import { parseJson } from '../specification/specifications';
import type { UpstreamResponse } from '../../http-client/upstream-client';
import { MarketplaceSearch } from '../marketplace-search';
import { TmfProxy } from '../tmf-proxy';
import type { UpstreamUser } from '../upstream-headers';
import { LaunchRequirements } from './launch-requirements';
import { OfferingParties } from './offering-parties';

type Json = Record<string, unknown>;

// What an offering is made of cannot be changed afterwards
const FIXED_FIELDS = ['isBundle', 'productSpecification', 'bundledProductOffering'];
// More than this many bundled offerings or categories is not an offering that anybody makes by hand
const MAX_BUNDLED = 50;
const MAX_CATEGORIES = 30;

const ID = /^[A-Za-z0-9:._-]{1,200}$/;
const IDS = /^[A-Za-z0-9:._-]{1,200}(,[A-Za-z0-9:._-]{1,200}){0,99}$/;

// What anybody may ask of the list of offerings, with what each filter may be; a category may also be one of the filters of the search engine
const offeringsQuery = z.strictObject({
    ...pagination,
    ...sorting(),
    lifecycleStatus: z.string().regex(/^[A-Za-z]{1,20}(,[A-Za-z]{1,20}){0,5}$/).optional(),
    isBundle: z.string().regex(/^(true|false)$/).optional(),
    'category.id': z.string().regex(/^[^&;#=]{1,500}$/).optional(),
    'name*': z.string().regex(/^[^&;#]{1,300}$/).optional(),
    keyword: z.string().regex(/^[^&;#]{1,200}$/).optional(),
    'relatedParty.id': z.string().regex(ID).optional(),
    'relatedParty.role': z.string().regex(/^[A-Za-z]{1,30}$/).optional(),
    // Whatever the client says about who the offerings are for, the proxy says it itself
    'relatedParty.role*': z.string().regex(/^.{1,200}$/).optional(),
    'productOfferingPrice.id': z.string().regex(IDS).optional(),
    'productSpecification.id': z.string().regex(ID).optional(),
    id: z.string().regex(IDS).optional()
});

const statusOf = (value: unknown): string => (typeof value === 'string' ? value.toLowerCase() : '');

const parseObject = (text: string): Json => {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) {
        throw new DomainError('Invalid body', 400);
    }
    return parsed;
};

/**
 * The offerings of the catalog API, as far as the portal uses them: one is read by anybody unless it was made for a buyer, who and
 * the seller are the only ones to see it; a seller makes them for the products they own (or for bundles of their own offerings), in
 * a catalog of theirs when the route says so, and changes and retires them. The charging backend checks an offering before it is
 * made and is told after it was made or changed; when it cannot be told the client is told what is left.
 */
@Injectable()
export class Offerings {
    private readonly logger = new Logger(Offerings.name);

    constructor(
        private readonly proxy: TmfProxy,
        private readonly config: AppConfigService,
        private readonly operator: OperatorService,
        private readonly parties: OfferingParties,
        private readonly charging: ChargingAssets,
        private readonly launch: LaunchRequirements,
        private readonly search: MarketplaceSearch
    ) {}

    private get roles(): { seller: string; customer: string } {
        return this.config.auth.roles;
    }

    private path(id: string): string {
        return `/productOffering/${encodeURIComponent(id)}`;
    }

    // ---- Read

    async read(req: Request, res: Response, id: string): Promise<void> {
        const response = await this.proxy.send(req, { upstream: 'tmforum.catalog', path: this.path(id), method: 'GET', search: '' });
        if (response.status >= 400) {
            this.proxy.reply(res, response);
            return;
        }
        const offering = parseJson(response.body);
        if (!isRecord(offering)) {
            throw new BadGatewayError('The offering could not be read');
        }
        // An offering made for a buyer is not given to anybody else, and nobody is told that it exists
        const forBuyer = this.hasBuyer(offering);
        if (forBuyer && !this.isBuyerOrSeller(req, offering)) {
            throw new NotFoundError('The required resource does not exist');
        }
        this.proxy.reply(res, response, forBuyer ? PRIVATE : {});
    }

    private hasBuyer(offering: Json): boolean {
        const customer = this.roles.customer.toLowerCase();
        return Array.isArray(offering['relatedParty']) && offering['relatedParty'].some((party) => isRecord(party) && statusOf(party['role']) === customer);
    }

    private isBuyerOrSeller(req: Request, offering: Json): boolean {
        const partyId = (req as Request & { user?: UpstreamUser }).user?.partyId;
        return typeof partyId === 'string' && (isRelatedAs(offering, partyId, this.roles.customer) || isRelatedAs(offering, partyId, this.roles.seller));
    }

    // ---- List

    /**
     * The offerings that the caller may read, as the catalog API pages them. The ones made for a buyer are for the buyer and the
     * seller only: unless the caller asks for the offerings of their own, the query leaves out the ones that name a buyer. A keyword
     * or a category goes to the search engine first, which pages and sorts and gives the ids, when the marketplace has one (a keyword without one is refused). On the
     * route of a catalog, the categories of the catalog are what the offerings have to be in.
     */
    async list(req: Request, res: Response, catalogId?: string): Promise<void> {
        const asked = this.listFilters(req);
        if (asked.has('keyword') && !this.search.enabled) {
            // A list that ignored the keyword would look like its answer
            throw new DomainError('The search is not available', 501);
        }
        const categories = catalogId === undefined ? undefined : await this.categoriesOfCatalog(req, catalogId);
        if (categories?.length === 0) {
            // A catalog with no categories has no offerings; v11 listed all of them
            this.proxy.reply(res, this.emptyList(), PRIVATE);
            return;
        }
        const partyId = (req as Request & { user?: UpstreamUser }).user?.partyId;
        const own = partyId !== undefined && asked.get('relatedParty.id') === partyId;
        const params = new URLSearchParams();
        let order: string[] | undefined;
        const keyword = asked.get('keyword');
        if (this.search.enabled && (keyword !== undefined || asked.has('category.id'))) {
            order = await this.search.offerings(req, {
                keyword: asked.get('keyword'),
                categories: asked.get('category.id'),
                sort: asked.get('sort'),
                offset: asked.get('offset'),
                limit: asked.get('limit'),
                organizationId: asked.get('relatedParty.id')
            });
            if (order.length === 0) {
                this.proxy.reply(res, this.emptyList(), own ? PRIVATE : {});
                return;
            }
            params.set('id', order.join(','));
            params.set('limit', asked.get('limit') ?? String(order.length));
        } else {
            for (const [name, value] of asked) {
                if (name !== 'relatedParty.role*') {
                    params.set(name, value);
                }
            }
            this.assertCategoryIds(params.get('category.id'));
        }
        if (categories !== undefined) {
            params.set('category', categories.join(','));
        }
        if (!own) {
            params.set('relatedParty.role*', `^(?!${this.roles.customer}$).*$`);
        }
        const response = await this.proxy.send(req, { upstream: 'tmforum.catalog', path: '/productOffering', method: 'GET', search: `?${params.toString()}` });
        this.proxy.reply(res, response.status >= 400 ? response : this.listed(req, response, order), own ? PRIVATE : {});
    }

    /** The page as the API gave it, in the order of the search engine when there was one, and with no offering that the caller may not read. */
    private listed(req: Request, response: UpstreamResponse, order: string[] | undefined): UpstreamResponse {
        const found = parseJson(response.body);
        if (!Array.isArray(found)) {
            throw new BadGatewayError('The offerings could not be read');
        }
        let offerings = (found as unknown[]).filter(isRecord);
        // The query leaves out what is for a buyer, but the roles of the offerings are kept as they were written: this is what the filter cannot see
        const readable = offerings.filter((offering) => !this.hasBuyer(offering) || this.isBuyerOrSeller(req, offering));
        if (readable.length < offerings.length) {
            this.logger.warn({ left: offerings.length - readable.length }, 'Offerings for a buyer came in a list of offerings and were left out');
        }
        offerings = readable;
        if (order !== undefined) {
            const place = new Map(order.map((id, index) => [id, index]));
            offerings = offerings.toSorted((a, b) => (place.get(String(a['id'])) ?? 0) - (place.get(String(b['id'])) ?? 0));
        }
        return readable.length === found.length && order === undefined ? response : { ...response, body: JSON.stringify(offerings) };
    }

    private emptyList(): UpstreamResponse {
        return { status: 200, headers: new Headers({ 'content-type': 'application/json', 'x-total-count': '0' }), body: '[]' };
    }

    private listFilters(req: Request): Map<string, string> {
        return new Map(queryParams(req.query, parseRequest(offeringsQuery, req.query, 'Invalid query')));
    }
    /** Without a search engine a category is the id of one. */
    private assertCategoryIds(categories: string | null): void {
        if (categories !== null && categories.split(',').some((id) => !isResourceId(id))) {
            throw new DomainError('Invalid query', 400);
        }
    }

    private async categoriesOfCatalog(req: Request, catalogId: string): Promise<string[]> {
        const catalog = await this.getRecord(req, `/catalog/${encodeURIComponent(catalogId)}`, new DomainError('The attached catalog cannot be read or does not exist', 422), 'The catalog could not be read');
        const categories = Array.isArray(catalog['category']) ? (catalog['category'] as unknown[]) : [];
        return categories.flatMap((category) => (isRecord(category) && typeof category['id'] === 'string' && isResourceId(category['id']) ? [category['id']] : []));
    }

    // ---- Create

    async create(req: Request, res: Response, text: string, catalogId?: string): Promise<void> {
        const { id: _id, href: _href, ...offering } = parseObject(text);
        if (!this.isSeller(req)) {
            throw new ForbiddenError('You are not authorized to create resources');
        }
        const partyId = callerParty(req, 'You are not authorized to create resources');
        validateNameAndDescription(offering, 'Product offering', true, this.config.limits);
        this.parties.assertShape(offering['relatedParty']);
        offering['validFor'] ??= { startDateTime: new Date().toISOString() };
        const launching = statusOf(offering['lifecycleStatus']) === 'launched';
        const product = await this.assertComposition(req, offering, partyId, ['active', 'launched'], 'Offerings can only be attached to active or launched products', 'create');
        const catalogCategory = catalogId === undefined ? undefined : await this.assertCatalog(req, catalogId, partyId);
        // The parties are looked up when they are needed, which is before the offering is checked for a launch and otherwise after the charging backend has checked it
        let parties: Json[] | undefined;
        const partiesOf = async (): Promise<Json[]> => (parties ??= await this.parties.of(req, offering['relatedParty'], partyId));
        if (launching) {
            await this.assertCanLaunch(req, { ...offering, relatedParty: await partiesOf() }, product);
        }
        const categories = await this.categoriesOf(req, offering['category'], partyId, catalogCategory === undefined ? [] : [catalogCategory]);
        if (categories.length > 0) {
            offering['category'] = categories;
        }
        // The charging backend checks the offering as the client sent it, as v11 did, and the parties and the schema are written after
        await this.charging.validateOffering(req, offering);
        offering['relatedParty'] = await partiesOf();
        offering['@schemaLocation'] = this.config.catalog.offeringSchema;
        const created = await this.proxy.send(req, { upstream: 'tmforum.catalog', path: '/productOffering', method: 'POST', body: JSON.stringify(offering), ...AS_JSON, search: '' });
        if (created.status >= 400) {
            this.proxy.reply(res, created);
            return;
        }
        const stored = parseJson(created.body);
        if (!isRecord(stored)) {
            throw new BadGatewayError('The offering was created but its answer could not be read');
        }
        await this.attachOrRetire(req, stored);
        this.logger.log({ offeringId: stored['id'] }, 'An offering was created');
        this.proxy.reply(res, created);
    }

    /** The charging backend is told the offering was made; if it cannot be, the offering is retired so that nobody can buy what it does not know. */
    private async attachOrRetire(req: Request, stored: Json): Promise<void> {
        try {
            await this.charging.attachOffering(req, stored);
        } catch (error) {
            const id = String(stored['id']);
            const reason = error instanceof Error ? error.message : 'unknown error';
            const left = await this.retiredAgain(req, id);
            throw new BadGatewayError(`The offering ${id} was created and the charging backend could not be told (${reason}); ${left}`);
        }
    }

    private async retiredAgain(req: Request, id: string): Promise<string> {
        try {
            const response = await this.proxy.send(req, { upstream: 'tmforum.catalog', path: this.path(id), method: 'PATCH', body: JSON.stringify({ lifecycleStatus: 'Retired' }), ...AS_JSON, search: '' });
            if (response.status < 400) {
                this.logger.warn({ offeringId: id }, 'An offering was retired because the charging backend could not be told that it was created');
                return 'it was retired';
            }
        } catch {
            // The same as an answer that refuses it
        }
        this.logger.warn({ offeringId: id }, 'An offering could not be retired after the charging backend could not be told that it was created');
        return 'it could not be retired and has to be retired by hand';
    }

    // ---- Update

    async update(req: Request, res: Response, id: string, text: string): Promise<void> {
        const { id: _id, href: _href, ...changes } = parseObject(text);
        const partyId = callerParty(req, 'The user making the request is not the owner of the accessed resource');
        const current = await this.readOne(req, id);
        await this.assertOwner(req, current, partyId);
        if ('relatedParty' in changes && !sameRelatedParties(current['relatedParty'], changes['relatedParty'])) {
            throw new DomainError('The field "relatedParty" can not be modified', 409);
        }
        if (current['validFor'] === undefined && changes['validFor'] === undefined) {
            changes['validFor'] = { startDateTime: new Date().toISOString() };
        }
        const status = changes['lifecycleStatus'];
        if (status !== undefined && status !== null && !isValidStatusTransition(current['lifecycleStatus'], status)) {
            throw new DomainError(`Cannot transition from lifecycle status ${String(current['lifecycleStatus'])} to ${String(status)}`, 400);
        }
        validateNameAndDescription(changes, 'Product offering', false, this.config.limits);
        for (const field of FIXED_FIELDS) {
            if (changes[field] && !isDeepStrictEqual(changes[field], current[field])) {
                throw new ForbiddenError(`Field ${field} cannot be modified`);
            }
        }
        if (statusOf(status) === 'launched') {
            const product = await this.assertComposition(req, current, partyId, ['launched'], 'Offerings can only be launched when the attached product is also launched', 'update');
            await this.assertCanLaunch(req, current, product);
        }
        if ('category' in changes) {
            changes['category'] = await this.categoriesOf(req, changes['category'], partyId, await this.catalogCategoriesOf(req, current));
        }
        changes['@schemaLocation'] = this.config.catalog.offeringSchema;
        const response = await this.proxy.send(req, { upstream: 'tmforum.catalog', path: this.path(id), body: JSON.stringify(changes), ...AS_JSON, search: '' });
        if (response.status < 400) {
            await this.tell(req, response.body, id, 'changed');
        }
        this.proxy.reply(res, response);
    }

    /** A delete retires the offering, which stays in the catalog. */
    async retire(req: Request, res: Response, id: string): Promise<void> {
        const partyId = callerParty(req, 'The user making the request is not the owner of the accessed resource');
        const current = await this.readOne(req, id);
        await this.assertOwner(req, current, partyId);
        if (isRetired(current['lifecycleStatus'])) {
            throw new DomainError('The resource is already retired', 409);
        }
        const response = await this.proxy.send(req, { upstream: 'tmforum.catalog', path: this.path(id), method: 'PATCH', body: JSON.stringify({ lifecycleStatus: 'Retired' }), ...AS_JSON, search: '' });
        if (response.status < 400) {
            await this.tell(req, response.body, id, 'retired');
        }
        this.proxy.reply(res, response);
    }

    /** The charging backend is told what the offering is now; the change was made, so when it cannot be told the client is told what is left. */
    private async tell(req: Request, body: string, id: string, done: string): Promise<void> {
        const stored = parseJson(body);
        try {
            await this.charging.updateOffering(req, isRecord(stored) ? stored : { id });
        } catch (error) {
            const reason = error instanceof Error ? error.message : 'unknown error';
            throw new BadGatewayError(`The offering ${id} was ${done} and the charging backend could not be told (${reason})`);
        }
        this.logger.log({ offeringId: id }, `An offering was ${done}`);
    }

    // ---- What an offering has to be

    private isSeller(req: Request): boolean {
        const seller = this.roles.seller.toLowerCase();
        return ((req as Request & { user?: UpstreamUser }).user?.roles ?? []).some((role) => role.name.toLowerCase() === seller);
    }

    private async readOne(req: Request, id: string): Promise<Json> {
        const response = await this.proxy.send(req, { upstream: 'tmforum.catalog', path: this.path(id), method: 'GET', search: '' });
        if (response.status === 404) {
            throw new NotFoundError('The required resource does not exist');
        }
        const found = parseJson(response.body);
        if (response.status >= 400 || !isRecord(found)) {
            throw new BadGatewayError('The offering could not be read');
        }
        return found;
    }

    private async getRecord(req: Request, path: string, absent: DomainError, failure: string): Promise<Json> {
        const response = await this.proxy.send(req, { upstream: 'tmforum.catalog', path, method: 'GET', search: '' });
        if (response.status === 404) {
            throw absent;
        }
        const found = parseJson(response.body);
        if (response.status >= 400 || !isRecord(found)) {
            throw new BadGatewayError(failure);
        }
        return found;
    }

    /** The caller owns the offering: they are its seller or, when it names nobody, the seller of its product. */
    private async assertOwner(req: Request, offering: Json, partyId: string): Promise<void> {
        if (!(await this.owns(req, offering, partyId))) {
            throw new ForbiddenError('The user making the request is not the owner of the accessed resource');
        }
    }

    private async owns(req: Request, offering: Json, partyId: string): Promise<boolean> {
        if (Array.isArray(offering['relatedParty']) && offering['relatedParty'].length > 0) {
            return isRelatedAs(offering, partyId, this.roles.seller);
        }
        const productId = isRecord(offering['productSpecification']) ? offering['productSpecification']['id'] : undefined;
        if (typeof productId !== 'string' || !isResourceId(productId)) {
            return false;
        }
        const response = await this.proxy.send(req, { upstream: 'tmforum.catalog', path: `/productSpecification/${encodeURIComponent(productId)}`, method: 'GET', search: '' });
        return response.status < 400 && isRelatedAs(parseJson(response.body), partyId, this.roles.seller);
    }

    /**
     * What the offering is made of: a bundle has at least two offerings of the caller and no product, and any other has the product
     * of the caller (which is given back). What it is made of has to be in one of the states.
     */
    private async assertComposition(req: Request, offering: Json, partyId: string, states: string[], wrongState: string, operation: 'create' | 'update'): Promise<Json> {
        if (offering['isBundle']) {
            await this.assertBundle(req, offering, partyId, states, wrongState);
            return {};
        }
        const bundled = offering['bundledProductOffering'];
        if (Array.isArray(bundled) && bundled.length > 0) {
            throw new DomainError('Product offerings which are not a bundle cannot contain a bundled product offering', 422);
        }
        const reference = offering['productSpecification'];
        if (!isRecord(reference) || Object.keys(reference).length === 0) {
            throw new DomainError('Product offerings must contain a productSpecification', 422);
        }
        if (typeof reference['id'] !== 'string' || !isResourceId(reference['id'])) {
            throw new DomainError('The product specification of the offering is not valid', 422);
        }
        const product = await this.getRecord(
            req,
            `/productSpecification/${encodeURIComponent(reference['id'])}`,
            new DomainError(`The product specification ${reference['id']} cannot be accessed or does not exists`, 422),
            'The product specification of the offering could not be read'
        );
        if (!isRelatedAs(product, partyId, this.roles.seller)) {
            throw new ForbiddenError(`You are not allowed to ${operation} offerings for products you do not own`);
        }
        if (!states.includes(statusOf(product['lifecycleStatus']))) {
            throw new DomainError(wrongState, 400);
        }
        return product;
    }

    private async assertBundle(req: Request, offering: Json, partyId: string, states: string[], wrongState: string): Promise<void> {
        if (offering['productSpecification']) {
            throw new DomainError('Product offering bundles cannot contain a product specification', 422);
        }
        const bundled = offering['bundledProductOffering'];
        if (!Array.isArray(bundled) || bundled.length < 2) {
            throw new DomainError('Product offering bundles must contain at least two bundled offerings', 422);
        }
        if (bundled.length > MAX_BUNDLED) {
            throw new DomainError(`Product offering bundles cannot contain more than ${MAX_BUNDLED} offerings`, 422);
        }
        for (const entry of bundled) {
            if (!isRecord(entry) || typeof entry['href'] !== 'string') {
                throw new DomainError('Missing required field href in bundled offering', 422);
            }
            const id = typeof entry['id'] === 'string' && isResourceId(entry['id']) ? entry['id'] : undefined;
            const missing = new DomainError(`The bundled offering ${String(entry['id'] ?? '')} cannot be accessed or does not exists`, 422);
            if (id === undefined) {
                throw missing;
            }
            const included = await this.getRecord(req, this.path(id), missing, 'The bundled offering could not be read');
            if (included['isBundle']) {
                throw new DomainError('Product offering bundles cannot include another bundle', 422);
            }
            if (!(await this.owns(req, included, partyId))) {
                throw new ForbiddenError('You are not allowed to bundle offerings you do not own');
            }
            if (!states.includes(statusOf(included['lifecycleStatus']))) {
                throw new DomainError(wrongState, 400);
            }
        }
    }

    /** The catalog of the route is the caller's and is active or launched; its category is the one that its offerings carry. */
    private async assertCatalog(req: Request, catalogId: string, partyId: string): Promise<Json> {
        const catalog = await this.getRecord(req, `/catalog/${encodeURIComponent(catalogId)}`, new NotFoundError('The required resource does not exist'), 'The catalog attached to the offering cannot be read');
        if (!isRelatedAs(catalog, partyId, this.roles.seller)) {
            throw new ForbiddenError('You are not allowed to create offerings in a catalog you do not own');
        }
        if (!['active', 'launched'].includes(statusOf(catalog['lifecycleStatus']))) {
            throw new DomainError('Offerings can only be created in a catalog that is active or launched', 400);
        }
        const [first] = Array.isArray(catalog['category']) ? catalog['category'] : [];
        return isRecord(first) ? first : {};
    }

    private async assertCanLaunch(req: Request, offering: Json, product: Json): Promise<void> {
        if (!(await this.launch.enabled())) {
            return;
        }
        const unmet = await this.launch.unmet(req, offering, product);
        if (unmet !== undefined) {
            this.logger.log(`The offering ${String(offering['id'] ?? 'to be created')} cannot be launched: ${unmet}`);
            throw new DomainError(`The product offering does not meet the requirements to be launched: ${unmet}`, 400);
        }
    }

    // ---- Categories

    /**
     * The categories of an offering, once each, as the category API has them, and the ones that `keep` names too. A category has to
     * exist, and the root category of a catalog is not for the offerings of anybody but the seller of the catalog. The categories
     * of the system and the ones of the marketplace are for everybody: they say what kind of offering it is.
     */
    private async categoriesOf(req: Request, wanted: unknown, partyId: string, keep: Json[]): Promise<Json[]> {
        const list = wanted === undefined || wanted === null ? [] : wanted;
        if (!Array.isArray(list) || list.length > MAX_CATEGORIES) {
            throw new DomainError('Invalid categories', 422);
        }
        const ids = new Set<string>();
        for (const entry of [...list, ...keep]) {
            if (!isRecord(entry) || typeof entry['id'] !== 'string' || !isResourceId(entry['id'])) {
                throw new DomainError('Invalid category', 422);
            }
            ids.add(entry['id']);
        }
        const categories: Json[] = [];
        for (const id of ids) {
            const category = await this.getRecord(req, `/category/${encodeURIComponent(id)}`, new DomainError(`Invalid category with id: ${id}`, 422), 'The category of the offering could not be read');
            if (this.isCatalogCategory(category) && !isRelatedAs(category, partyId, this.roles.seller)) {
                throw new ForbiddenError(`You are not allowed to use the category ${id}`);
            }
            categories.push({ id, href: category['href'] ?? id, name: category['name'] });
        }
        return categories;
    }

    /** The root category that a seller's catalog has, which is owned by the seller and not by the marketplace. */
    private isCatalogCategory(category: Json): boolean {
        const operatorId = this.operator.seller()?.['id'];
        const seller = this.roles.seller.toLowerCase();
        return (
            category['isRoot'] === true &&
            Array.isArray(category['relatedParty']) &&
            category['relatedParty'].some((party) => isRecord(party) && statusOf(party['role']) === seller && party['id'] !== operatorId)
        );
    }

    /** The categories of catalogs that the offering has now, which a change keeps whatever it says. */
    private async catalogCategoriesOf(req: Request, offering: Json): Promise<Json[]> {
        const current = Array.isArray(offering['category']) ? offering['category'] : [];
        const kept: Json[] = [];
        for (const entry of current.slice(0, MAX_CATEGORIES)) {
            if (!isRecord(entry) || typeof entry['id'] !== 'string' || !isResourceId(entry['id'])) {
                continue;
            }
            const category = await this.getRecord(req, `/category/${encodeURIComponent(entry['id'])}`, new DomainError('Invalid category', 422), 'The category of the offering could not be read');
            if (this.isCatalogCategory(category)) {
                kept.push(entry);
            }
        }
        return kept;
    }
}
