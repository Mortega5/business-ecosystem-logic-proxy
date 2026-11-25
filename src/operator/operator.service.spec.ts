import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppConfigService } from '../config/app-config.service';
import { UpstreamClient, type UpstreamRequest } from '../http-client/upstream-client';
import { OperatorService } from './operator.service';

type Query = Record<string, string>;

class FakeUpstream extends UpstreamClient {
    queries: Query[] = [];
    organizations: Record<string, unknown[]> = {};
    failing = false;
    unanswered = 0;
    send(): never {
        throw new Error('not used');
    }
    override json<T>(request: UpstreamRequest): Promise<T> {
        const query = request.query as Query;
        this.queries.push(query);
        if (this.failing) {
            return Promise.reject(new Error('down'));
        }
        if (this.queries.length <= this.unanswered) {
            return Promise.resolve([] as T);
        }
        return Promise.resolve((this.organizations[Object.values(query)[0] as string] ?? []) as T);
    }
}

const settle = async (): Promise<void> => {
    for (let turn = 0; turn < 20; turn += 1) {
        await Promise.resolve();
    }
};

const make = (id: string, upstream: FakeUpstream) =>
    new OperatorService({ operator: { id }, auth: { roles: { seller: 'Seller' } } } as unknown as AppConfigService, upstream);

describe('OperatorService', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('has no operator, and asks for nothing, when none is configured', async () => {
        const upstream = new FakeUpstream();
        const operator = make('', upstream);
        operator.onApplicationBootstrap();
        await settle();
        expect(upstream.queries).toEqual([]);
        expect(operator.seller()).toBeUndefined();
        expect(operator.owner()).toBeUndefined();
        operator.onModuleDestroy();
    });

    it('finds the organization by its identification, with did:elsi: added, and names it with the roles', async () => {
        const upstream = new FakeUpstream();
        upstream.organizations['did:elsi:VATES-1'] = [{ id: 'urn:org:1' }];
        const operator = make('VATES-1', upstream);
        operator.onApplicationBootstrap();
        await settle();
        expect(upstream.queries[0]).toEqual({ 'organizationIdentification.identificationId': 'did:elsi:VATES-1' });
        expect(operator.seller()).toEqual({ id: 'urn:org:1', href: 'urn:org:1', name: 'VATES-1', role: 'SellerOperator', '@referredType': 'Organization' });
        expect(operator.buyer()).toMatchObject({ role: 'BuyerOperator' });
        expect(operator.owner()).toMatchObject([{ role: 'Seller' }, { role: 'SellerOperator' }]);
        operator.onModuleDestroy();
    });

    it('goes on to the external reference, with the DID and as configured', async () => {
        const upstream = new FakeUpstream();
        upstream.organizations['did:web:op.example.org'] = [{ id: 'urn:org:2' }];
        upstream.unanswered = 1;
        const operator = make('did:web:op.example.org', upstream);
        operator.onApplicationBootstrap();
        await settle();
        expect(upstream.queries.map((query) => Object.keys(query)[0])).toEqual(['organizationIdentification.identificationId', 'externalReference.name']);
        expect(operator.seller()).toMatchObject({ id: 'urn:org:2' });
        operator.onModuleDestroy();
    });

    it('tries again when the party API fails, and has no operator until it answers', async () => {
        vi.useFakeTimers();
        const upstream = new FakeUpstream();
        upstream.failing = true;
        upstream.organizations['did:elsi:X'] = [{ id: 'urn:org:3' }];
        const operator = make('X', upstream);
        operator.onApplicationBootstrap();
        await vi.advanceTimersByTimeAsync(0);
        expect(operator.seller()).toBeUndefined();
        upstream.failing = false;
        await vi.advanceTimersByTimeAsync(5000);
        expect(operator.seller()).toMatchObject({ id: 'urn:org:3' });
        operator.onModuleDestroy();
    });

    it('stops asking once it is destroyed', async () => {
        vi.useFakeTimers();
        const upstream = new FakeUpstream();
        upstream.failing = true;
        const operator = make('X', upstream);
        operator.onApplicationBootstrap();
        await vi.advanceTimersByTimeAsync(0);
        const asked = upstream.queries.length;
        operator.onModuleDestroy();
        await vi.advanceTimersByTimeAsync(60000);
        expect(upstream.queries.length).toBe(asked);
    });
});
