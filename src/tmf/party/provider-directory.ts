import { Injectable, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { BadGatewayError, DomainError } from '../../common/domain-error';
import { AppConfigService } from '../../config/app-config.service';
import { OperatorService } from '../../operator/operator.service';
import { MarketplaceSearch } from '../marketplace-search';
import { isRecord } from '../related-party';
import { isResourceId } from '../resource-id.pipe';
import { parseJson } from '../specification/specifications';
import { TmfProxy } from '../tmf-proxy';

interface Provider {
    id: string;
    name: string;
}

interface Directory {
    at: number;
    providers: Provider[];
}

const PAGE = 100;

const lower = (value: unknown): string => (typeof value === 'string' ? value.toLowerCase() : '');

/**
 * The directory of providers: the organisations that have launched offerings. With a search engine it is the engine that finds them,
 * for a keyword and for the list; without one the organisations are the sellers of the launched offerings that anybody may read
 * (without the operator of the marketplace), which are kept for a while, sorted by their name and cut into the page that was asked
 * for, so a page is full and the total is the number of providers.
 */
@Injectable()
export class ProviderDirectory {
    private readonly logger = new Logger(ProviderDirectory.name);
    private directory: Directory | undefined;
    private reading: Promise<Directory> | undefined;

    constructor(
        private readonly proxy: TmfProxy,
        private readonly config: AppConfigService,
        private readonly search: MarketplaceSearch,
        private readonly operator: OperatorService
    ) {}

    /** Whether a list of organisations is the directory: it asks for the launched ones or for a keyword. */
    static isDirectoryQuery(query: URLSearchParams): boolean {
        return lower(query.get('lifecycleStatus')) === 'launched' || (query.get('keyword') ?? '').trim() !== '';
    }

    async list(req: Request, res: Response, query: URLSearchParams): Promise<void> {
        const keyword = (query.get('keyword') ?? '').trim();
        if (this.search.enabled) {
            return this.listFound(req, res, query, keyword);
        }
        if (keyword !== '') {
            // Without an engine there is nothing that searches by name, and a list that ignored the keyword would look like its answer
            throw new DomainError('The search is not available', 501);
        }
        return this.listKept(req, res, query);
    }

    // ---- With a search engine

    private async listFound(req: Request, res: Response, query: URLSearchParams, keyword: string): Promise<void> {
        const ids = await this.search.organizations(req, { keyword, offset: query.get('offset') ?? undefined, limit: query.get('limit') ?? undefined });
        if (ids.length === 0) {
            this.proxy.reply(res, this.page([], 0));
            return;
        }
        const params = new URLSearchParams({ id: ids.join(','), limit: query.get('limit') ?? String(ids.length) });
        const fields = query.get('fields');
        if (fields !== null) {
            params.set('fields', fields);
        }
        const response = await this.proxy.send(req, { upstream: 'tmforum.party', path: '/organization', method: 'GET', search: `?${params.toString()}` });
        const found = parseJson(response.body);
        if (response.status >= 400 || !Array.isArray(found)) {
            this.proxy.reply(res, response);
            return;
        }
        const place = new Map(ids.map((id, index) => [id, index]));
        const ordered = (found as unknown[]).toSorted((a, b) => (place.get(isRecord(a) ? String(a['id']) : '') ?? 0) - (place.get(isRecord(b) ? String(b['id']) : '') ?? 0));
        this.proxy.reply(res, { ...response, body: JSON.stringify(ordered) });
    }

    // ---- Without one

    private async listKept(req: Request, res: Response, query: URLSearchParams): Promise<void> {
        const providers = (await this.providers(req)).toSorted((a, b) => (a.name === b.name ? (a.id < b.id ? -1 : 1) : a.name < b.name ? -1 : 1));
        if (query.get('sort')?.startsWith('-') === true) {
            providers.reverse();
        }
        const offset = Number.parseInt(query.get('offset') ?? '0', 10);
        const limit = Number.parseInt(query.get('limit') ?? String(this.config.limits.readAll.pageSize), 10);
        const shown = providers.slice(offset, offset + limit);
        if (shown.length === 0) {
            this.proxy.reply(res, this.page([], providers.length));
            return;
        }
        const params = new URLSearchParams({ id: shown.map((provider) => provider.id).join(','), limit: String(shown.length) });
        const fields = query.get('fields');
        if (fields !== null) {
            params.set('fields', fields);
        }
        const response = await this.proxy.send(req, { upstream: 'tmforum.party', path: '/organization', method: 'GET', search: `?${params.toString()}` });
        const found = parseJson(response.body);
        if (response.status >= 400 || !Array.isArray(found)) {
            this.proxy.reply(res, response);
            return;
        }
        const place = new Map(shown.map((provider, index) => [provider.id, index]));
        const ordered = (found as unknown[]).toSorted((a, b) => (place.get(isRecord(a) ? String(a['id']) : '') ?? 0) - (place.get(isRecord(b) ? String(b['id']) : '') ?? 0));
        this.proxy.reply(res, { ...response, headers: this.headers(providers.length), body: JSON.stringify(ordered) });
    }

    private headers(total: number): Headers {
        return new Headers({ 'content-type': 'application/json', 'x-total-count': String(total) });
    }

    private page(items: unknown[], total: number): { status: number; headers: Headers; body: string } {
        return { status: 200, headers: this.headers(total), body: JSON.stringify(items) };
    }

    /** The organisations with launched offerings, kept for a while; what asks while they are being read waits for the same reading. */
    private providers(req: Request): Promise<Provider[]> {
        const now = Date.now();
        if (this.directory !== undefined && now - this.directory.at < this.config.limits.providerCacheMs) {
            return Promise.resolve(this.directory.providers);
        }
        this.reading ??= this.read(req)
            .then((directory) => {
                this.directory = directory;
                return directory;
            })
            .finally(() => {
                this.reading = undefined;
            });
        return this.reading.then((directory) => directory.providers);
    }

    private async read(req: Request): Promise<Directory> {
        const sellers = await this.sellers(req);
        const operatorId = this.operator.seller()?.['id'];
        const wanted = [...sellers].filter((id) => id !== operatorId);
        const providers: Provider[] = [];
        const { providersPerQuery } = this.config.limits;
        for (let from = 0; from < wanted.length; from += providersPerQuery) {
            const batch = wanted.slice(from, from + providersPerQuery);
            const search = `?id=${batch.map(encodeURIComponent).join(',')}&fields=tradingName&limit=${batch.length}`;
            const response = await this.proxy.send(req, { upstream: 'tmforum.party', path: '/organization', method: 'GET', search });
            const found = parseJson(response.body);
            if (response.status >= 400 || !Array.isArray(found)) {
                throw new BadGatewayError('The providers could not be read');
            }
            for (const organization of found as unknown[]) {
                if (isRecord(organization) && typeof organization['id'] === 'string') {
                    providers.push({ id: organization['id'], name: typeof organization['tradingName'] === 'string' ? organization['tradingName'] : '' });
                }
            }
        }
        this.logger.log(`The directory of providers has ${providers.length} of the ${sellers.size} sellers of launched offerings`);
        return { at: Date.now(), providers };
    }

    /** The sellers of the launched offerings that anybody may read, which are not the ones made for a buyer. */
    private async sellers(req: Request): Promise<Set<string>> {
        const { roles } = this.config.auth;
        const sellers = new Set<string>();
        const { maxPages } = this.config.limits.readAll;
        for (let page = 0; page < maxPages; page += 1) {
            const params = new URLSearchParams({ lifecycleStatus: 'Launched', fields: 'relatedParty', limit: String(PAGE), offset: String(page * PAGE), 'relatedParty.role*': `^(?!${roles.customer}$).*$` });
            const response = await this.proxy.send(req, { upstream: 'tmforum.catalog', path: '/productOffering', method: 'GET', search: `?${params.toString()}` });
            const found = parseJson(response.body);
            if (response.status >= 400 || !Array.isArray(found)) {
                throw new BadGatewayError('The offerings of the providers could not be read');
            }
            for (const offering of found as unknown[]) {
                const parties = isRecord(offering) && Array.isArray(offering['relatedParty']) ? (offering['relatedParty'] as unknown[]) : [];
                for (const party of parties) {
                    if (isRecord(party) && lower(party['role']) === roles.seller.toLowerCase() && typeof party['id'] === 'string' && isResourceId(party['id'])) {
                        sellers.add(party['id']);
                    }
                }
            }
            if (found.length < PAGE) {
                return sellers;
            }
        }
        throw new BadGatewayError('There are more launched offerings than the directory of providers reads');
    }
}
