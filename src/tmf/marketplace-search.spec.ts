import type { Request } from 'express';
import { describe, expect, it, vi } from 'vitest';
import type { AppConfigService } from '../config/app-config.service';
import type { SearchSettings } from '../features/search-settings';
import { MarketplaceSearch } from './marketplace-search';
import type { TmfProxy } from './tmf-proxy';

const answer = { status: 200, headers: new Headers(), body: '[{"id":"urn:ngsi-ld:product-offering:1"}]' };
const build = (inQuery?: boolean) => {
    const send = vi.fn((_req: Request, _target: { path: string; search?: string }) => Promise.resolve(answer));
    const settings = inQuery === undefined ? undefined : ({ useQueryKeyword: () => Promise.resolve(inQuery) } as SearchSettings);
    return { send, search: new MarketplaceSearch({ send } as unknown as TmfProxy, { search: { enabled: true } } as AppConfigService, settings) };
};
const REQ = {} as Request;
const QUERY = { keyword: 'cloud data', categories: undefined, sort: undefined, offset: '0', limit: '12', organizationId: undefined };

describe('where the keyword goes', () => {
    it.each([['no setting', undefined], ['the setting off', false]])('is in the path of the engine with %s', async (_name, inQuery) => {
        const { send, search } = build(inQuery);

        await search.offerings(REQ, QUERY);
        await search.organizations(REQ, { keyword: 'cloud data', offset: '0', limit: '12' });

        expect(send.mock.calls.map(([, target]) => target.path)).toEqual(['/api/SearchProduct/cloud%20data', '/api/searchOrganizations/cloud%20data']);
    });

    it('is in the query of the engine when the administrator says so', async () => {
        const { send, search } = build(true);

        await search.offerings(REQ, QUERY);
        await search.offerings(REQ, { ...QUERY, offset: undefined, limit: undefined });
        await search.organizations(REQ, { keyword: 'cloud data', offset: '0', limit: '12' });

        const targets = send.mock.calls.map(([, target]) => target);
        expect(targets.map((target) => target.path)).toEqual(['/api/SearchProduct', '/api/SearchProduct', '/api/searchOrganizations']);
        expect(new URLSearchParams(targets[0]?.search).get('query')).toBe('cloud data');
        expect(targets[1]?.search).toBe('?query=cloud%20data');
        expect(new URLSearchParams(targets[2]?.search).get('query')).toBe('cloud data');
    });

    it('is nowhere when there is no keyword', async () => {
        const { send, search } = build(true);

        await search.offerings(REQ, { ...QUERY, keyword: undefined });

        const target = send.mock.calls[0]?.[1];
        expect(target?.path).toBe('/api/SearchProduct');
        expect(target?.search ?? '').not.toContain('query');
    });
});
