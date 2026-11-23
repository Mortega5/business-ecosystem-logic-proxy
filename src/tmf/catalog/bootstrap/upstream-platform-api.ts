import { Injectable } from '@nestjs/common';
import type { z } from 'zod';
import type { UpstreamName } from '../../../config/upstream-names';
import { AppConfigService } from '../../../config/app-config.service';
import { UpstreamClient } from '../../../http-client/upstream-client';
import { catalog, type Catalog, type CatalogChanges, type CatalogDraft } from '../../schemas/catalog';
import { category, type Category, type CategoryDraft } from '../../schemas/category';
import { parseEntity } from '../../schemas/parse';
import { resourceSpecification, type ResourceSpecification } from '../../schemas/resource-specification';
import type { CatalogApi, SoftwareApi } from './platform-api';

const HEADERS = { 'content-type': 'application/json', accept: 'application/json' };

/**
 * Calls straight to the APIs of the TMForum, with no user: they are the proxy's own, so no validation of a request is applied. What
 * they answer is checked against the schemas of the entities, and is refused when it is not what the start-up reads.
 */
@Injectable()
export class UpstreamPlatformApi implements CatalogApi, SoftwareApi {
    constructor(
        private readonly upstream: UpstreamClient,
        private readonly config: AppConfigService
    ) {}

    private async one<S extends z.ZodType>(schema: S, what: string, upstream: UpstreamName, path: string, method: string, body?: object): Promise<z.infer<S>> {
        const found = await this.upstream.json({ upstream, path, method, headers: HEADERS, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        return parseEntity(schema, found, `${what} (${method} ${path})`);
    }

    /** One that may not be there: a 404 is `null`, and any other failure is an error. */
    private async orNull<S extends z.ZodType>(schema: S, what: string, upstream: UpstreamName, path: string): Promise<z.infer<S> | null> {
        const response = await this.upstream.send({ upstream, path, method: 'GET', headers: HEADERS });
        if (response.status === 404) {
            return null;
        }
        if (response.status >= 400) {
            throw new Error(`${upstream} answered ${response.status} to GET ${path}`);
        }
        return parseEntity(schema, JSON.parse(response.body), `${what} (GET ${path})`);
    }

    private async list<S extends z.ZodType>(schema: S, what: string, upstream: UpstreamName, path: string, query: Record<string, string>): Promise<z.infer<S>[]> {
        const items: z.infer<S>[] = [];
        const { pageSize, maxPages } = this.config.limits.readAll;
        for (let page = 0; page < maxPages; page += 1) {
            const found = await this.upstream.json<unknown>({ upstream, path, method: 'GET', headers: HEADERS, query: { limit: String(pageSize), offset: String(page * pageSize), ...query } });
            if (!Array.isArray(found)) {
                throw new Error(`${upstream} did not answer a list to GET ${path}`);
            }
            found.forEach((row, index) => items.push(parseEntity(schema, row, `${what} ${page * pageSize + index} of GET ${path}`)));
            if (found.length < pageSize) {
                return items;
            }
        }
        // What was read is not all there is, and the start-up must not decide on a part of it
        throw new Error(`${upstream} has more than ${maxPages * pageSize} to answer to GET ${path}: raise limits.readAll`);
    }

    private async remove(upstream: UpstreamName, path: string): Promise<void> {
        await this.upstream.json({ upstream, path, method: 'DELETE', headers: HEADERS });
    }

    getCatalog = (id: string): Promise<Catalog | null> => this.orNull(catalog, 'The catalog', 'tmforum.catalog', `/catalog/${encodeURIComponent(id)}`);
    listCatalogs = (query: Record<string, string>): Promise<Catalog[]> => this.list(catalog, 'The catalog', 'tmforum.catalog', '/catalog', query);
    createCatalog = (draft: CatalogDraft): Promise<Catalog> => this.one(catalog, 'The catalog made', 'tmforum.catalog', '/catalog', 'POST', draft);
    updateCatalog = async (id: string, changes: CatalogChanges): Promise<void> => {
        await this.one(catalog, 'The catalog changed', 'tmforum.catalog', `/catalog/${encodeURIComponent(id)}`, 'PATCH', changes);
    };
    deleteCatalog = (id: string): Promise<void> => this.remove('tmforum.catalog', `/catalog/${encodeURIComponent(id)}`);
    getCategory = (id: string): Promise<Category | null> => this.orNull(category, 'The category', 'tmforum.catalog', `/category/${encodeURIComponent(id)}`);
    listCategories = (query: Record<string, string>): Promise<Category[]> => this.list(category, 'The category', 'tmforum.catalog', '/category', query);
    createCategory = (draft: CategoryDraft): Promise<Category> => this.one(category, 'The category made', 'tmforum.catalog', '/category', 'POST', draft);
    deleteCategory = (id: string): Promise<void> => this.remove('tmforum.catalog', `/category/${encodeURIComponent(id)}`);
    getResourceSpec = (id: string): Promise<ResourceSpecification | null> => this.orNull(resourceSpecification, 'The specification', 'tmforum.software', `/resourceSpecification/${encodeURIComponent(id)}`);
    listResourceSpecs = (query: Record<string, string>): Promise<ResourceSpecification[]> => this.list(resourceSpecification, 'The specification', 'tmforum.software', '/resourceSpecification', query);
    createResourceSpec = (draft: object): Promise<ResourceSpecification> => this.one(resourceSpecification, 'The specification made', 'tmforum.software', '/resourceSpecification', 'POST', draft);
    deleteResourceSpec = (id: string): Promise<void> => this.remove('tmforum.software', `/resourceSpecification/${encodeURIComponent(id)}`);
}
