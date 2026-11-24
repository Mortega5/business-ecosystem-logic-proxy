import { Injectable } from '@nestjs/common';
import { BadGatewayError } from '../common/domain-error';
import { AppConfigService } from '../config/app-config.service';
import type { UpstreamName } from '../config/upstream-names';
import { UpstreamClient, UpstreamError } from '../http-client/upstream-client';

const HEADERS = { accept: 'application/json' };

/**
 * Reads what a TMForum collection has, with no user: the figures are the proxy's own and show nothing that is not public. It reads page after
 * page up to `limits.readAll`, and gives up with an error, never with a part of the list, since a count of a part would be a wrong one.
 */
@Injectable()
export class TmfReader {
    constructor(
        private readonly upstream: UpstreamClient,
        private readonly config: AppConfigService
    ) {}

    /** All the items of the collection that match the query. */
    async all(upstream: UpstreamName, path: string, query: Record<string, string>, signal?: AbortSignal): Promise<Record<string, unknown>[]> {
        const items: Record<string, unknown>[] = [];
        const { pageSize, maxPages } = this.config.limits.readAll;
        for (let page = 0; page < maxPages; page += 1) {
            signal?.throwIfAborted();
            const found = await this.page(upstream, path, { ...query, limit: String(pageSize), offset: String(page * pageSize) });
            for (const item of found) {
                if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
                    items.push(item as Record<string, unknown>);
                }
            }
            if (found.length < pageSize) {
                return items;
            }
        }
        throw new BadGatewayError(`${path} has more than ${maxPages * pageSize} items: raise limits.readAll`);
    }

    /** One query, with the parameters already encoded in the search string. */
    async some(upstream: UpstreamName, path: string, search: string): Promise<unknown[]> {
        return this.read(upstream, path, { search });
    }

    private page(upstream: UpstreamName, path: string, query: Record<string, string>): Promise<unknown[]> {
        return this.read(upstream, path, { query });
    }

    private async read(upstream: UpstreamName, path: string, how: { query: Record<string, string> } | { search: string }): Promise<unknown[]> {
        let found: unknown;
        try {
            found = await this.upstream.json<unknown>({ upstream, path, method: 'GET', headers: HEADERS, ...how });
        } catch (error) {
            if (error instanceof UpstreamError) {
                throw new BadGatewayError(`${path} could not be read (${error.kind}${error.status === undefined ? '' : ` ${error.status}`})`);
            }
            throw error;
        }
        if (!Array.isArray(found)) {
            throw new BadGatewayError(`${path} did not answer a list`);
        }
        return found as unknown[];
    }
}
