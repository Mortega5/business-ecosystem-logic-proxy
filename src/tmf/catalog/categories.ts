import { Injectable, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { pagination, queryParams, sorting } from '../schemas/pagination';
import { parseRequest } from '../schemas/parse';
import { BadGatewayError, DomainError, ForbiddenError, NotFoundError } from '../../common/domain-error';
import { AppConfigService } from '../../config/app-config.service';
import type { UpstreamResponse } from '../../http-client/upstream-client';
import { OperatorService } from '../../operator/operator.service';
import { AS_JSON } from '../http-options';
import { isRecord } from '../related-party';
import { isResourceId } from '../resource-id.pipe';
import { isValidStatusTransition, sameRelatedParties } from '../specification/specification-rules';
import { parseJson } from '../specification/specifications';
import { TmfProxy } from '../tmf-proxy';
import { CatalogDefaults } from './catalog-defaults';
import { categoryShape, systemEntityViolation, type CategoryShape } from './category-rules';

type Json = Record<string, unknown>;

// A chain of parents longer than this is not a taxonomy
const MAX_DEPTH = 20;

// What anybody may ask of the list of categories, with what each filter may be
const categoriesQuery = z.strictObject({
    ...pagination,
    ...sorting(),
    lifecycleStatus: z.string().regex(/^[A-Za-z]{1,20}(,[A-Za-z]{1,20}){0,5}$/).optional(),
    parentId: z.string().regex(/^[A-Za-z0-9:._-]{1,200}$/).optional(),
    isRoot: z.string().regex(/^(true|false)$/).optional()
});

const RETIRED = ['retired', 'obsolete'];

/**
 * The categories of the catalog API, as far as the portal uses them. Anybody reads them; an administrator creates and changes them.
 * A category is root or has a parent that exists, has a name that no other launched category of the same parent has, and the root
 * ones are listed by the default catalog, which is kept in line when one is made or retired. The system categories are the platform's.
 */
@Injectable()
export class Categories {
    private readonly logger = new Logger(Categories.name);

    constructor(
        private readonly proxy: TmfProxy,
        private readonly config: AppConfigService,
        private readonly operator: OperatorService,
        private readonly defaults: CatalogDefaults
    ) {}

    private path(id: string): string {
        return `/category/${encodeURIComponent(id)}`;
    }

    // ---- Reads, open to anybody

    list(req: Request, res: Response): Promise<void> {
        const params = queryParams(req.query, parseRequest(categoriesQuery, req.query, 'Invalid query'));
        return this.proxy.forward(req, res, { upstream: 'tmforum.catalog', path: '/category', search: params.size === 0 ? '' : `?${params.toString()}` });
    }

    read(req: Request, res: Response, id: string): Promise<void> {
        return this.proxy.forward(req, res, { upstream: 'tmforum.catalog', path: this.path(id), search: '' });
    }

    // ---- Create

    async create(req: Request, res: Response, text: string): Promise<void> {
        const { id: _id, href: _href, ...category } = JSON.parse(text) as Json;
        category['validFor'] ??= { startDateTime: new Date().toISOString() };
        const shape = categoryShape(category, undefined, this.config.limits.nameLength);
        // A category that does not say is root, and says so
        category['isRoot'] = shape.isRoot;
        if (shape.parentId === null) {
            delete category['parentId'];
        }
        await this.assertPlace(req, shape, undefined);
        // What the platform owns is owned by the operator, when the marketplace has one
        const owner = this.operator.owner();
        if (owner !== undefined) {
            category['relatedParty'] = owner;
            category['@schemaLocation'] = this.config.catalog.partyLocation;
        }
        const created = await this.proxy.send(req, { upstream: 'tmforum.catalog', path: '/category', method: 'POST', body: JSON.stringify(category), ...AS_JSON, search: '' });
        if (created.status < 400 && shape.isRoot) {
            const stored = parseJson(created.body);
            await this.listInDefaultCatalog(req, isRecord(stored) ? stored : {}, 'created');
        }
        this.proxy.reply(res, created);
    }

    // ---- Update

    async update(req: Request, res: Response, id: string, text: string): Promise<void> {
        const changes = JSON.parse(text) as Json;
        const violation = systemEntityViolation(this.defaults, 'category', 'PATCH', id, changes);
        if (violation !== undefined) {
            throw new ForbiddenError(violation);
        }
        const previous = await this.readOne(req, this.path(id), 'The required resource does not exist');
        if ('relatedParty' in changes && !sameRelatedParties(previous['relatedParty'] ?? [], changes['relatedParty'])) {
            throw new DomainError('The field "relatedParty" can not be modified', 409);
        }
        if (previous['validFor'] === undefined && changes['validFor'] === undefined) {
            changes['validFor'] = { startDateTime: new Date().toISOString() };
        }
        const status = changes['lifecycleStatus'];
        if (status !== undefined && status !== null && !isValidStatusTransition(previous['lifecycleStatus'], status)) {
            throw new DomainError(`Cannot transition from lifecycle status ${JSON.stringify(previous['lifecycleStatus'])} to ${JSON.stringify(status)}`, 400);
        }
        const shape = categoryShape(changes, previous, this.config.limits.nameLength);
        if (shape.needsChecks) {
            await this.assertPlace(req, shape, id);
        }
        const response = await this.proxy.send(req, { upstream: 'tmforum.catalog', path: this.path(id), body: JSON.stringify(changes), ...AS_JSON, search: '' });
        if (response.status < 400) {
            const stored = parseJson(response.body);
            if (isRecord(stored) && typeof stored['lifecycleStatus'] === 'string' && RETIRED.includes(stored['lifecycleStatus'].toLowerCase())) {
                await this.unlistFromDefaultCatalog(req, id);
            }
        }
        this.proxy.reply(res, response);
    }

    // ---- What a category has to be

    private async readOne(req: Request, path: string, missing: string): Promise<Json> {
        const response = await this.proxy.send(req, { upstream: 'tmforum.catalog', path, method: 'GET', search: '' });
        const found = parseJson(response.body);
        if (response.status === 404) {
            throw new NotFoundError(missing);
        }
        if (response.status >= 400 || !isRecord(found)) {
            throw new BadGatewayError('The category API could not be read');
        }
        return found;
    }

    /** The parent exists and is not below the category, and no other launched category of the same parent has its name. */
    private async assertPlace(req: Request, shape: CategoryShape, own: string | undefined): Promise<void> {
        if (!shape.needsChecks) {
            return;
        }
        if (!shape.isRoot && shape.parentId !== null) {
            await this.assertParent(req, shape.parentId, own);
        }
        const params = new URLSearchParams({ lifecycleStatus: 'Launched', name: shape.name, ...(shape.isRoot ? { isRoot: 'true' } : { parentId: shape.parentId ?? '' }) });
        const response = await this.proxy.send(req, { upstream: 'tmforum.catalog', path: '/category', method: 'GET', search: `?${params.toString()}` });
        const same = parseJson(response.body);
        if (response.status >= 400 || !Array.isArray(same)) {
            throw new BadGatewayError('It was impossible to check if the provided category already exists');
        }
        if (same.some((other) => !isRecord(other) || other['id'] !== own)) {
            throw new DomainError('This category already exists', 409);
        }
    }

    private async assertParent(req: Request, parentId: string, own: string | undefined): Promise<void> {
        let next: string | undefined = parentId;
        for (let depth = 0; next !== undefined; depth += 1) {
            if (next === own || depth > MAX_DEPTH) {
                throw new DomainError('A category cannot be below itself', 400);
            }
            const response = await this.proxy.send(req, { upstream: 'tmforum.catalog', path: this.path(next), method: 'GET', search: '' });
            if (response.status === 404) {
                throw new DomainError(`Invalid category with id: ${next}`, 400);
            }
            const parent = parseJson(response.body);
            if (response.status >= 400 || !isRecord(parent)) {
                throw new BadGatewayError(`It was impossible to check if the category with id: ${next} already exists`);
            }
            const above = parent['parentId'];
            next = typeof above === 'string' && above !== '' && isResourceId(above) ? above : undefined;
        }
    }

    // ---- The default catalog, which lists the root categories

    private async listInDefaultCatalog(req: Request, category: Json, done: string): Promise<void> {
        const catalogId = this.defaults.defaultCatalogId;
        if (catalogId === '') {
            // There is none yet: the start-up lists the categories it needs when it finds one
            this.logger.warn('The category cannot be added to the default catalog: there is none yet');
            return;
        }
        const left = `The category ${String(category['id'])} was ${done} and could not be added to the default catalog`;
        const catalog = await this.readCatalog(req, catalogId, left);
        const listed: unknown[] = Array.isArray(catalog['category']) ? (catalog['category'] as unknown[]) : [];
        if (listed.some((entry) => isRecord(entry) && entry['id'] === category['id'])) {
            return;
        }
        await this.writeCatalog(req, catalogId, [...listed, { id: category['id'], href: category['href'], name: category['name'] }], left);
    }

    private async unlistFromDefaultCatalog(req: Request, id: string): Promise<void> {
        const catalogId = this.defaults.defaultCatalogId;
        if (catalogId === '') {
            return;
        }
        const left = `The category ${id} was changed and could not be removed from the default catalog`;
        const catalog = await this.readCatalog(req, catalogId, left);
        const listed: unknown[] = Array.isArray(catalog['category']) ? (catalog['category'] as unknown[]) : [];
        const kept = listed.filter((entry) => !(isRecord(entry) && entry['id'] === id));
        if (kept.length !== listed.length) {
            await this.writeCatalog(req, catalogId, kept, left);
        }
    }

    private async readCatalog(req: Request, catalogId: string, left: string): Promise<Json> {
        try {
            return await this.readOne(req, `/catalog/${encodeURIComponent(catalogId)}`, 'Missing default catalog in the system');
        } catch (error) {
            this.logger.warn({ catalogId, err: error }, 'The default catalog could not be read');
            throw new BadGatewayError(left);
        }
    }

    private async writeCatalog(req: Request, catalogId: string, category: unknown[], left: string): Promise<void> {
        let response: UpstreamResponse;
        try {
            response = await this.proxy.send(req, { upstream: 'tmforum.catalog', path: `/catalog/${encodeURIComponent(catalogId)}`, method: 'PATCH', body: JSON.stringify({ category }), ...AS_JSON, search: '' });
        } catch (error) {
            this.logger.warn({ catalogId, err: error }, 'The default catalog could not be changed');
            throw new BadGatewayError(left);
        }
        if (response.status >= 400) {
            this.logger.warn({ catalogId, statusCode: response.status }, 'The default catalog could not be changed');
            throw new BadGatewayError(left);
        }
    }
}
