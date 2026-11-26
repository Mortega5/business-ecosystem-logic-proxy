import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PinoLogger } from 'nestjs-pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DomainError, NotFoundError } from '../../common/domain-error';
import type { AppConfigService } from '../../config/app-config.service';
import { I4TrustProvider } from '../providers/i4trust-provider';
import { IdentityProviderRegistry } from '../providers/identity-provider-registry';
import { TEST_CERTIFICATE, TEST_KEY } from '../providers/ishare-fixtures';
import type { NewIdpForm } from './idp-form';
import type { IdpRepository } from './idp.repository';
import type { Idp } from './idp.schema';
import { IdpService } from './idp.service';

class MemoryRepository {
    records: Idp[] = [];
    find = vi.fn(() => Promise.resolve(this.records.map((record) => (Object.assign({}, record)))));
    search = vi.fn((text: string) => Promise.resolve(this.records.filter((record) => record.name.includes(text))));
    findOne = vi.fn(({ idpId }: { idpId: string }) =>
        Promise.resolve(this.records.find((record) => record.idpId === idpId))
    );
    create = vi.fn((record: Idp) => {
        if (this.records.some((existing) => existing.idpId === record.idpId)) {
            return Promise.reject(Object.assign(new Error('E11000 duplicate key'), { code: 11000 }));
        }
        this.records.push(record);
        return Promise.resolve(record);
    });
    replace = vi.fn((idpId: string, record: Idp) => {
        this.records = this.records.map((existing) => (existing.idpId === idpId ? record : existing));
        return Promise.resolve(true);
    });
    deleteMany = vi.fn(({ idpId }: { idpId: string }) => {
        this.records = this.records.filter((record) => record.idpId !== idpId);
        return Promise.resolve(1);
    });
}

const dir = mkdtempSync(join(tmpdir(), 'bae-idp-'));
const tokenKey = join(dir, 'key.pem');
const tokenCrt = join(dir, 'crt.pem');
writeFileSync(tokenKey, TEST_KEY);
writeFileSync(tokenCrt, TEST_CERTIFICATE);

const configWith = (
    externalLogin: Record<string, unknown> = { enabled: true, eori: 'EU.EORI.PROXY', tokenKey, tokenCrt }
) =>
    ({
        auth: {
            roles: { admin: 'admin', customer: 'Buyer', seller: 'Seller', orgAdmin: 'orgAdmin' },
            idpTimeoutMs: 1000,
            idp: { provider: 'keycloak', callbackUrl: 'https://bae.example.org/auth/keycloak/callback' },
            externalLogin
        }
    }) as unknown as AppConfigService;

const logger = { setContext: vi.fn(), info: vi.fn(), error: vi.fn() } as unknown as PinoLogger;
const form: NewIdpForm = {
    idpId: 'EU.EORI.IDP1',
    name: 'Idp one',
    server: 'https://idp1.example.org',
    description: 'The first'
};

describe('IdpService', () => {
    let repository: MemoryRepository;
    let registry: IdentityProviderRegistry;
    let service: IdpService;

    beforeEach(() => {
        repository = new MemoryRepository();
        registry = new IdentityProviderRegistry();
        service = new IdpService(repository as unknown as IdpRepository, registry, configWith(), logger);
    });

    it('adds a provider: keeps it as v11 kept it, with the client, the key and the callback, and makes it available for login', async () => {
        await service.create(form);

        expect(repository.records[0]).toEqual({
            provider: 'i4trust',
            name: 'Idp one',
            server: 'https://idp1.example.org',
            idpId: 'EU.EORI.IDP1',
            clientID: 'EU.EORI.PROXY',
            callbackURL: 'https://bae.example.org/auth/EU.EORI.IDP1/callback',
            tokenKey,
            tokenCrt,
            description: 'The first'
        });
        expect(registry.get('EU.EORI.IDP1')).toBeInstanceOf(I4TrustProvider);
        expect(registry.callbackUrlOf('EU.EORI.IDP1')).toBe('https://bae.example.org/auth/EU.EORI.IDP1/callback');
    });

    it('does not add the same id twice, nor the one of the main provider, nor one that is not there', async () => {
        await service.create(form);
        await expect(service.create(form)).rejects.toMatchObject({ status: 409 });
        for (const idpId of ['local', 'keycloak']) {
            await expect(service.create({ ...form, idpId })).rejects.toBeInstanceOf(DomainError);
        }
        expect(repository.records).toHaveLength(1);

        const closed = new IdpService(
            repository as unknown as IdpRepository,
            registry,
            configWith({ enabled: false }),
            logger
        );
        await expect(closed.create({ ...form, idpId: 'other' })).rejects.toBeInstanceOf(NotFoundError);
        // With the external login off the routes are not there, as in v11
        await expect(closed.list()).rejects.toBeInstanceOf(NotFoundError);
        await expect(closed.get('EU.EORI.IDP1')).rejects.toBeInstanceOf(NotFoundError);
        await expect(closed.update('EU.EORI.IDP1', { name: 'x', server: 'https://x.example.org' })).rejects.toBeInstanceOf(NotFoundError);
        await expect(closed.remove('EU.EORI.IDP1')).rejects.toBeInstanceOf(NotFoundError);
    });

    it('does not keep a provider that cannot be built', async () => {
        const broken = new IdpService(
            repository as unknown as IdpRepository,
            registry,
            configWith({ enabled: true, eori: 'E', tokenKey: join(dir, 'none.pem'), tokenCrt }),
            logger
        );
        await expect(broken.create(form)).rejects.toThrow('ENOENT');
        expect(repository.records).toHaveLength(0);
        expect(registry.get(form.idpId)).toBeUndefined();
    });

    it('tells of a provider with what v11 told, and of all of them or the ones that match', async () => {
        await service.create({ ...form, issuerDid: 'did:web:one' });
        await service.create({ ...form, idpId: 'EU.EORI.IDP2', name: 'Other' });

        expect(await service.get('EU.EORI.IDP1')).toEqual({
            name: 'Idp one',
            server: 'https://idp1.example.org',
            idpId: 'EU.EORI.IDP1',
            issuerDid: 'did:web:one',
            description: 'The first'
        });
        expect(await service.list()).toHaveLength(2);
        expect((await service.list('Other')).map((idp) => idp.idpId)).toEqual(['EU.EORI.IDP2']);
        await expect(service.get('missing')).rejects.toBeInstanceOf(NotFoundError);
    });

    it('does not show the key, the client or the callback of the record', async () => {
        await service.create(form);
        expect(Object.keys(await service.get('EU.EORI.IDP1')).sort()).toEqual([
            'description',
            'idpId',
            'name',
            'server'
        ]);
    });

    it('changes a provider, removes what the change leaves out, and keeps the id, the client and the callback', async () => {
        await service.create({ ...form, issuerDid: 'did:web:one' });
        const before = registry.get('EU.EORI.IDP1');

        await service.update('EU.EORI.IDP1', { name: 'New name', server: 'https://new.example.org' });

        expect(repository.records[0]).toMatchObject({
            name: 'New name',
            server: 'https://new.example.org',
            idpId: 'EU.EORI.IDP1',
            clientID: 'EU.EORI.PROXY'
        });
        expect(repository.records[0]).not.toHaveProperty('issuerDid');
        expect(repository.records[0]).not.toHaveProperty('description');
        expect(registry.get('EU.EORI.IDP1')).not.toBe(before);
        await expect(service.update('missing', { name: 'x', server: 'https://x.example.org' })).rejects.toBeInstanceOf(
            NotFoundError
        );
    });

    it('removes a provider and its login', async () => {
        await service.create(form);
        await service.remove('EU.EORI.IDP1');
        expect(repository.records).toHaveLength(0);
        expect(registry.get('EU.EORI.IDP1')).toBeUndefined();
        expect(registry.callbackUrlOf('EU.EORI.IDP1')).toBeUndefined();
    });

    it('loads the providers that are kept when it starts, and goes on when one cannot be loaded', async () => {
        const record = (idpId: string, provider = 'i4trust'): Idp => ({
            provider,
            name: idpId,
            server: 'https://idp.example.org',
            idpId,
            clientID: 'EU.EORI.PROXY',
            callbackURL: `https://bae.example.org/auth/${idpId}/callback`,
            tokenKey,
            tokenCrt
        });
        repository.records = [record('a'), record('old', 'other'), record('b')];

        await service.loadStored();

        expect(registry.get('a')).toBeDefined();
        expect(registry.get('b')).toBeDefined();
        expect(registry.get('old')).toBeUndefined();

        const closed = new IdpService(
            repository as unknown as IdpRepository,
            new IdentityProviderRegistry(),
            configWith({ enabled: false }),
            logger
        );
        repository.find.mockClear();
        await closed.loadStored();
        expect(repository.find).not.toHaveBeenCalled();
    });
});
