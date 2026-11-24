import { Injectable, Logger, Optional } from '@nestjs/common';
import type { Request } from 'express';
import { BadGatewayError, DomainError } from '../common/domain-error';
import { AppConfigService } from '../config/app-config.service';
import { SearchSettings } from '../features/search-settings';
import { AS_JSON } from './http-options';
import { isRecord } from './related-party';
import { isResourceId } from './resource-id.pipe';
import { parseJson } from './specification/specifications';
import { TmfProxy } from './tmf-proxy';

export interface OfferingSearchQuery {
    keyword: string | undefined;
    /** The ids of categories, and the filters of the search engine written as `name::value`, separated by commas. */
    categories: string | undefined;
    sort: string | undefined;
    offset: string | undefined;
    limit: string | undefined;
    organizationId: string | undefined;
}

// What the proxy sets in the search itself, which a filter of the client cannot replace
const RESERVED = ['categories', 'organizationId'];

const SORTS: Record<string, string> = {
    name: 'productOfferingName,asc',
    lastUpdate: 'productOfferingLastUpdate,asc',
    '-lastUpdate': 'productOfferingLastUpdate,desc'
};

/**
 * The search engine of the marketplace, which finds the offerings that a keyword or some categories name, and the organisations that a keyword names. It pages and sorts on its
 * own and gives the ids, which are then asked of the catalog API. It works with the names of the categories, and with the filters of
 * the portal that are written `name::value`, which it takes as they are.
 */
@Injectable()
export class MarketplaceSearch {
    private readonly logger = new Logger(MarketplaceSearch.name);

    constructor(
        private readonly proxy: TmfProxy,
        private readonly config: AppConfigService,
        // Where the keyword goes is a setting of the administrator; without the setting (a module that has no database) it goes in the path
        @Optional() private readonly settings?: SearchSettings
    ) {}

    private byQuery(): Promise<boolean> {
        return this.settings?.useQueryKeyword() ?? Promise.resolve(false);
    }

    /** Whether the marketplace has a search engine; without one a keyword is not looked at, as v11 did. */
    get enabled(): boolean {
        return this.config.search.enabled;
    }

    /** The ids of the organisations that the engine finds for a keyword, in its order. */
    async organizations(req: Request, query: { keyword: string | undefined; offset: string | undefined; limit: string | undefined }): Promise<string[]> {
        const keyword = query.keyword?.trim() ?? '';
        const params = new URLSearchParams(this.pageOf({ keyword, categories: undefined, sort: undefined, offset: query.offset, limit: query.limit, organizationId: undefined }).replace(/^\?/, ''));
        params.set('considerAllOrgs', 'false');
        const inQuery = keyword !== '' && (await this.byQuery());
        if (inQuery) {
            params.set('query', keyword);
        }
        const path = keyword === '' || inQuery ? '/api/searchOrganizations' : `/api/searchOrganizations/${encodeURIComponent(keyword)}`;
        const body = JSON.stringify({ categories: [], countries: [], complianceLevels: [] });
        const response = await this.proxy.send(req, { upstream: 'search', path, method: 'POST', body, ...AS_JSON, search: `?${params.toString()}` });
        return this.idsOf(response.status, response.body, 'organisations');
    }

    /** The ids of the offerings found, in the order of the engine. */
    async offerings(req: Request, query: OfferingSearchQuery): Promise<string[]> {
        const keyword = query.keyword?.trim() ?? '';
        const { categories, filters } = this.filtersOf(query.categories);
        const body: Record<string, unknown> = { categories: await this.namesOf(req, categories), ...filters };
        if (query.organizationId !== undefined && query.organizationId.trim() !== '') {
            body['organizationId'] = query.organizationId;
        }
        const inQuery = keyword !== '' && (await this.byQuery());
        const path = keyword === '' || inQuery ? '/api/SearchProduct' : `/api/SearchProduct/${encodeURIComponent(keyword)}`;
        const page = this.pageOf(query);
        const search = inQuery ? `${page === '' ? '?' : `${page}&`}query=${encodeURIComponent(keyword)}` : page;
        const response = await this.proxy.send(req, { upstream: 'search', path, method: 'POST', body: JSON.stringify(body), ...AS_JSON, search });
        return this.idsOf(response.status, response.body, 'offerings');
    }

    private idsOf(status: number, body: string, what: string): string[] {
        const found = parseJson(body);
        if (status >= 400 || !Array.isArray(found)) {
            this.logger.warn(`The search engine answered ${status} to a search of ${what}`);
            throw new BadGatewayError('The search engine could not be asked');
        }
        return (found as unknown[]).flatMap((one) => (isRecord(one) && typeof one['id'] === 'string' && isResourceId(one['id']) ? [one['id']] : []));
    }

    private pageOf(query: OfferingSearchQuery): string {
        const params = new URLSearchParams();
        const sort = query.sort === undefined ? undefined : SORTS[query.sort];
        if (sort !== undefined) {
            params.set('sort', sort);
        }
        const offset = Number.parseInt(query.offset ?? '', 10);
        const size = Number.parseInt(query.limit ?? '', 10);
        if (Number.isFinite(offset) && Number.isFinite(size) && size > 0) {
            params.set('page', String(Math.floor(offset / size)));
            params.set('size', String(size));
        }
        const text = params.toString().replaceAll('%2C', ',');
        return text === '' ? '' : `?${text}`;
    }

    /** A token with a name and a value between `::` is a filter of the engine; any other is the id of a category. */
    private filtersOf(text: string | undefined): { categories: string[]; filters: Record<string, string[]> } {
        const categories: string[] = [];
        const filters: Record<string, string[]> = {};
        for (const raw of (text ?? '').split(',')) {
            const token = raw.trim();
            const at = token.indexOf('::');
            if (token === '') {
                continue;
            }
            const name = at > 0 ? token.slice(0, at).trim() : '';
            const value = at > 0 ? token.slice(at + 2).trim() : '';
            if (name === '' || value === '' || at >= token.length - 2) {
                categories.push(token);
            } else if (RESERVED.includes(name)) {
                throw new DomainError('Invalid query', 400);
            } else {
                (filters[name] ??= []).push(value);
            }
        }
        return { categories, filters };
    }

    private async namesOf(req: Request, ids: string[]): Promise<string[]> {
        return Promise.all(ids.map((id) => this.nameOf(req, id)));
    }

    private async nameOf(req: Request, id: string): Promise<string> {
        if (!isResourceId(id)) {
            throw new DomainError('Invalid query', 400);
        }
        const response = await this.proxy.send(req, { upstream: 'tmforum.catalog', path: `/category/${encodeURIComponent(id)}`, method: 'GET', search: '' });
        if (response.status === 404) {
            throw new DomainError('Invalid query', 400);
        }
        const category = parseJson(response.body);
        if (response.status >= 400 || !isRecord(category) || typeof category['name'] !== 'string') {
            throw new BadGatewayError(`The category ${id} could not be read`);
        }
        return category['name'];
    }
}
