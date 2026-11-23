import { describe, expect, it } from 'vitest';
import type { AppConfigService } from '../../../config/app-config.service';
import { UpstreamClient, type UpstreamRequest, type UpstreamResponse } from '../../../http-client/upstream-client';
import { UpstreamPlatformApi } from './upstream-platform-api';

/** An upstream that answers by method and path, and keeps what it was asked. */
class FakeUpstream extends UpstreamClient {
    asked: UpstreamRequest[] = [];
    constructor(private readonly answers: (request: UpstreamRequest) => { status: number; body: unknown }) {
        super();
    }

    send(request: UpstreamRequest): Promise<UpstreamResponse> {
        this.asked.push(request);
        const { status, body } = this.answers(request);
        return Promise.resolve({ status, headers: new Headers(), body: typeof body === 'string' ? body : JSON.stringify(body) });
    }
}

const settings = (readAll = { pageSize: 100, maxPages: 100 }): AppConfigService => ({ limits: { readAll } }) as unknown as AppConfigService;
const api = (answers: (request: UpstreamRequest) => { status: number; body: unknown }, readAll?: { pageSize: number; maxPages: number }): { api: UpstreamPlatformApi; upstream: FakeUpstream } => {
    const upstream = new FakeUpstream(answers);
    return { api: new UpstreamPlatformApi(upstream, settings(readAll)), upstream };
};

describe('UpstreamPlatformApi', () => {
    it('gives an entity as the type that is read, and nothing when it is not there', async () => {
        const { api: found } = api(() => ({ status: 200, body: { id: 'c-1', relatedParty: [{ id: 'p-1', role: 'Seller' }] } }));
        const { api: missing } = api(() => ({ status: 404, body: {} }));

        expect((await found.getCatalog('c-1'))?.relatedParty?.[0]?.role).toBe('Seller');
        expect(await missing.getCatalog('c-1')).toBeNull();
    });

    it('refuses what the TMForum answers when it is not what is read, and says what, so a party with no role is not taken for a buyer', async () => {
        const { api: bad } = api(() => ({ status: 200, body: { id: 'c-1', relatedParty: [{ id: 'p-1' }] } }));

        await expect(bad.getCatalog('c-1')).rejects.toThrow('relatedParty.0.role');
    });

    it('fails when the API fails, and does not take an error for a missing entity', async () => {
        const { api: down } = api(() => ({ status: 500, body: {} }));

        await expect(down.getCatalog('c-1')).rejects.toThrow('answered 500');
    });

    it('reads a list page after page and stops at the page that is not full, checking each one', async () => {
        const page = (from: number, length: number) => Array.from({ length }, (_, index) => ({ id: `c-${from + index}` }));
        const { api: listing, upstream } = api((request) => ({ status: 200, body: request.query?.['offset'] === '0' ? page(0, 100) : page(100, 3) }));

        expect(await listing.listCatalogs({ catalogType: 'default' })).toHaveLength(103);
        expect(upstream.asked.map((request) => request.query)).toEqual([
            { limit: '100', offset: '0', catalogType: 'default' },
            { limit: '100', offset: '100', catalogType: 'default' }
        ]);
        const { api: broken } = api(() => ({ status: 200, body: [{ id: 'c-1' }, { name: 'no id' }] }));
        await expect(broken.listCatalogs({})).rejects.toThrow('The catalog 1 of GET /catalog');
        const { api: notAList } = api(() => ({ status: 200, body: { id: 'c-1' } }));
        await expect(notAList.listCatalogs({})).rejects.toThrow('did not answer a list');
    });

    it('reads with the page size of the limits, and fails when there is more than the pages it may read, instead of deciding on a part', async () => {
        const { api: small, upstream } = api((request) => ({ status: 200, body: Array.from({ length: 2 }, (_, index) => ({ id: `c-${String(request.query?.['offset'])}-${index}` })) }), { pageSize: 2, maxPages: 3 });

        await expect(small.listCatalogs({})).rejects.toThrow('has more than 6 to answer to GET /catalog: raise limits.readAll');
        expect(upstream.asked.map((request) => request.query?.['limit'])).toEqual(['2', '2', '2']);
    });

    it('sends what it makes and changes as JSON to the entity it names, with the id encoded', async () => {
        const { api: writing, upstream } = api(() => ({ status: 200, body: { id: 'c-1' } }));

        await writing.createCatalog({ name: 'default', description: '', catalogType: 'default', lifecycleStatus: 'Launched', category: [] });
        await writing.updateCatalog('urn:ngsi-ld:catalog:1', { catalogType: 'default' });

        expect(upstream.asked.map((request) => [request.method, request.path])).toEqual([['POST', '/catalog'], ['PATCH', '/catalog/urn%3Angsi-ld%3Acatalog%3A1']]);
        expect(JSON.parse(upstream.asked[1]?.body as string)).toEqual({ catalogType: 'default' });
        expect(upstream.asked[0]?.upstream).toBe('tmforum.catalog');
    });

    it('asks the software API for the specifications of the support packages', async () => {
        const { api: software, upstream } = api(() => ({ status: 200, body: [{ id: 's-1', '@type': 'SoftwareSupportPackageSpecification' }] }));

        expect(await software.listResourceSpecs({ '@type': 'SoftwareSupportPackageSpecification' })).toHaveLength(1);
        expect(upstream.asked[0]).toMatchObject({ upstream: 'tmforum.software', path: '/resourceSpecification' });
    });
});
