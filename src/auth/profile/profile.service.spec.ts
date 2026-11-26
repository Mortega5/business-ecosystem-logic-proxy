import type { AppConfigService } from '../../config/app-config.service';
import type { PinoLogger } from 'nestjs-pino';
import { describe, expect, it, vi } from 'vitest';
import { BadGatewayError, UnauthorizedError } from '../../common/domain-error';
import { listenToMetricEvents, type MetricEvents } from '../../metrics/metric-events';
import type { IdentityProvider, IdentityTokens } from '../providers/identity-provider';
import { IdentityProviderRegistry } from '../providers/identity-provider-registry';
import { MemoryAuthStore } from '../store/memory-auth-store';
import type { PartyRegistry } from './party-registry';
import { ProfileService } from './profile.service';
import type { IdentityClaims } from './user-profile';

const CONFIG = { auth: { replacedTokenGraceMs: 30_000, profileTtlMs: 7_200_000, refreshMarginSeconds: 5, defaultTokenLifetimeSeconds: 1800 } } as AppConfigService;
const later = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const nowS = (): number => Math.floor(Date.now() / 1000);

const ana: IdentityClaims = { id: 'idm-ana', username: 'ana', roles: [{ name: 'seller' }], organizations: [{ id: 'org-1', name: 'Acme', roles: [{ name: 'seller' }] }] };

class FakeProvider implements IdentityProvider {
    claimsCalls: string[] = [];
    refreshCalls: string[] = [];
    valid = new Map<string, IdentityClaims>();
    refreshed: IdentityTokens = { accessToken: 'new-token', refreshToken: 'new-refresh', expire: nowS() + 3600 };
    refreshFails = false;

    constructor(readonly id: string) {}

    async claimsOf(accessToken: string): Promise<IdentityClaims> {
        this.claimsCalls.push(accessToken);
        await later();
        const claims = this.valid.get(accessToken);
        if (claims === undefined) {
            throw new Error('invalid token');
        }
        return claims;
    }

    async refresh(refreshToken: string): Promise<IdentityTokens> {
        this.refreshCalls.push(refreshToken);
        await later();
        if (this.refreshFails) {
            throw new Error('refresh token used');
        }
        this.valid.set(this.refreshed.accessToken, ana);
        return this.refreshed;
    }
}

class FakeParties {
    individualCalls = 0;
    failing = false;

    async individualFor(): Promise<string> {
        this.individualCalls += 1;
        await later();
        if (this.failing) {
            throw new Error('TMForum is down');
        }
        return 'urn:ngsi-ld:individual:1';
    }

    async organizationsFor(claims: IdentityClaims): Promise<IdentityClaims['organizations']> {
        return claims.organizations.map((org) => ({ ...org, partyId: 'urn:ngsi-ld:organization:1' }));
    }
}

const logger = { setContext: () => undefined, info: () => undefined, warn: () => undefined, debug: () => undefined } as unknown as PinoLogger;

const setup = () => {
    const local = new FakeProvider('local');
    const fiware = new FakeProvider('fiware');
    const providers = new IdentityProviderRegistry();
    providers.add(local);
    providers.add(fiware);
    const parties = new FakeParties();
    const store = new MemoryAuthStore(100);
    const service = new ProfileService(store, providers, parties as unknown as PartyRegistry, CONFIG, logger);
    return { local, fiware, providers, parties, store, service };
};

describe('ProfileService: a token the proxy has not seen', () => {
    it('is asked to the main identity provider, and its user gets a party and the default expiry', async () => {
        const { local, service } = setup();
        local.valid.set('api-token', ana);

        const profile = await service.authenticate('api-token');

        expect(profile).toMatchObject({
            id: 'idm-ana',
            displayName: 'ana',
            idp: 'local',
            partyId: 'urn:ngsi-ld:individual:1',
            accessToken: 'api-token',
            refreshToken: '',
            organizations: [{ id: 'org-1', partyId: 'urn:ngsi-ld:organization:1' }]
        });
        expect(profile.expire - nowS()).toBeGreaterThan(1800 - 5);
        expect(profile.expire - nowS()).toBeLessThanOrEqual(1800);
    });

    it('is asked only once while it is valid', async () => {
        const { local, service } = setup();
        local.valid.set('api-token', ana);

        await service.authenticate('api-token');
        await service.authenticate('api-token');

        expect(local.claimsCalls).toHaveLength(1);
    });

    it('is asked once when many requests bring it at once, and the party is looked up once', async () => {
        const { local, parties, service } = setup();
        local.valid.set('api-token', ana);

        await Promise.all([service.authenticate('api-token'), service.authenticate('api-token'), service.authenticate('api-token')]);

        expect(local.claimsCalls).toHaveLength(1);
        expect(parties.individualCalls).toBe(1);
    });

    it('uses the expiry the provider gives', async () => {
        const { local, service } = setup();
        local.valid.set('api-token', { ...ana, expire: nowS() + 120 });

        expect((await service.authenticate('api-token')).expire).toBe(nowS() + 120);
    });

    it('is refused when the provider does not accept it, and nothing is kept', async () => {
        const { service, store } = setup();

        await expect(service.authenticate('forged')).rejects.toBeInstanceOf(UnauthorizedError);
        expect(await store.get('profile:forged')).toBeUndefined();
    });

    it('is refused when there is no main identity provider', async () => {
        const { providers, service } = setup();
        providers.remove('local');

        await expect(service.authenticate('api-token')).rejects.toBeInstanceOf(UnauthorizedError);
    });

    it('is a failure of the gateway, not of the user, when TMForum cannot register the person', async () => {
        const { local, parties, service } = setup();
        local.valid.set('api-token', ana);
        parties.failing = true;

        await expect(service.authenticate('api-token')).rejects.toBeInstanceOf(BadGatewayError);
    });

    it('is kept only as long as it lives when it cannot be refreshed, and two hours when it can', async () => {
        const { local, service, store } = setup();
        const ttls: Record<string, number> = {};
        const set = store.set.bind(store);
        store.set = async (key, value, ttlMs) => {
            ttls[key] = ttlMs;
            await set(key, value, ttlMs);
        };
        local.valid.set('api-token', { ...ana, expire: nowS() + 120 });

        await service.authenticate('api-token');
        await service.admit(ana, { accessToken: 'login-token', refreshToken: 'r', expire: nowS() + 120 }, 'fiware');

        expect(ttls['profile:api-token']).toBeGreaterThan(115_000);
        expect(ttls['profile:api-token']).toBeLessThanOrEqual(120_000);
        expect(ttls['profile:login-token']).toBe(7_200_000);
    });
});

describe('ProfileService: a token that ends', () => {
    const admitNearExpiry = async (setupResult: ReturnType<typeof setup>, refreshToken = 'refresh-1'): Promise<void> => {
        await setupResult.service.admit(ana, { accessToken: 'old-token', refreshToken, expire: nowS() + 2 }, 'fiware');
    };

    it('is used as it is while it has more than a few seconds left', async () => {
        const context = setup();
        await context.service.admit(ana, { accessToken: 'token', refreshToken: 'r', expire: nowS() + 600 }, 'fiware');

        expect((await context.service.authenticate('token')).accessToken).toBe('token');
        expect(context.fiware.refreshCalls).toEqual([]);
    });

    it('is refreshed with the provider it came from, and the new tokens are kept', async () => {
        const context = setup();
        await admitNearExpiry(context);

        const profile = await context.service.authenticate('old-token');

        expect(context.fiware.refreshCalls).toEqual(['refresh-1']);
        expect(profile).toMatchObject({ accessToken: 'new-token', refreshToken: 'new-refresh', idp: 'fiware' });
        expect((await context.service.authenticate('new-token')).accessToken).toBe('new-token');
    });

    it('is refreshed once when many requests find it ending at once, because a refresh token is used once', async () => {
        const context = setup();
        await admitNearExpiry(context);

        const profiles = await Promise.all([context.service.authenticate('old-token'), context.service.authenticate('old-token'), context.service.authenticate('old-token')]);

        expect(context.fiware.refreshCalls).toHaveLength(1);
        expect(profiles.map((profile) => profile.accessToken)).toEqual(['new-token', 'new-token', 'new-token']);
    });

    it('lets a late request with the old token have the renewed profile instead of a refused one', async () => {
        const context = setup();
        await admitNearExpiry(context);
        await context.service.authenticate('old-token');

        const late = await context.service.authenticate('old-token');

        expect(late.accessToken).toBe('new-token');
        expect(context.fiware.refreshCalls).toHaveLength(1);
    });

    it('keeps the replaced token for the grace time of the configuration, and no longer', async () => {
        const context = setup();
        const ttls: Record<string, number> = {};
        const set = context.store.set.bind(context.store);
        context.store.set = async (key, value, ttlMs) => {
            ttls[key] = ttlMs;
            await set(key, value, ttlMs);
        };
        await admitNearExpiry(context);

        await context.service.authenticate('old-token');

        expect(ttls['profile:old-token']).toBe(30_000);
    });

    it('is refused when the provider does not refresh it', async () => {
        const context = setup();
        await admitNearExpiry(context);
        context.fiware.refreshFails = true;

        await expect(context.service.authenticate('old-token')).rejects.toBeInstanceOf(UnauthorizedError);
    });

    it('is refused when it cannot be refreshed because it came without a refresh token', async () => {
        const context = setup();
        await admitNearExpiry(context, '');

        await expect(context.service.authenticate('old-token')).rejects.toBeInstanceOf(UnauthorizedError);
        expect(context.fiware.refreshCalls).toEqual([]);
    });

    it('is refused when the provider it came from is not in use any more', async () => {
        const context = setup();
        await admitNearExpiry(context);
        context.providers.remove('fiware');

        await expect(context.service.authenticate('old-token')).rejects.toBeInstanceOf(UnauthorizedError);
    });
});

describe('ProfileService: forgetting', () => {
    it('removes the profile of a token, which then has to be validated again', async () => {
        const { local, service } = setup();
        local.valid.set('api-token', ana);
        await service.authenticate('api-token');

        await service.forget('api-token');
        await service.authenticate('api-token');

        expect(local.claimsCalls).toHaveLength(2);
    });
});

describe('ProfileService: the metrics', () => {
    it('tells a token it has not seen as a miss, and the next one as a hit', async () => {
        const { local, service } = setup();
        local.valid.set('api-token', ana);
        const profileCache = vi.fn();
        const stop = listenToMetricEvents({ profileCache } as unknown as MetricEvents);
        try {
            await service.authenticate('api-token');
            await service.authenticate('api-token');
        } finally {
            stop();
        }

        expect(profileCache.mock.calls).toEqual([['miss'], ['hit']]);
    });
});
