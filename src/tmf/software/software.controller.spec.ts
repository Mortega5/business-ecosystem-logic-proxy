import { Module } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuthModule } from '../../auth/auth.module';
import { createApp } from '../../bootstrap';
import { AppConfigModule } from '../../config/app-config.module';
import { LoggingModule } from '../../logging/logging.module';
import { AS_SELLER, useFakeLogin, LOGGED_IN } from '../../testing/fake-login';
import { FakeUpstream } from '../../testing/fake-upstream';
import { CatalogDefaults } from '../catalog/catalog-defaults';
import { SoftwareModule } from './software.module';

const upstream = new FakeUpstream();

@Module({ imports: [AppConfigModule, LoggingModule, AuthModule, SoftwareModule] })
class Root {}

const BASE = '/tmf-api/softwareCompute/v4';
const JSON_HEADERS = { 'content-type': 'application/json' };
const SELLER = { id: 'p-shop', role: 'Seller' };
const NORMALIZED = { id: 'p-shop', href: 'p-shop', name: 'u-sam', role: 'Seller', '@referredType': 'Individual' };
const HELM = [{ name: 'deploymentDefinition', value: { type: 'helm', properties: { chart: 'oci://example/chart' } } }];
const SUPPORT_TYPE = 'SoftwareSupportPackageSpecification';
const SUPPORT_NAME = 'Global Software Support Package Specification';

interface Reply {
    status: number;
    body: string;
}
interface Seen {
    method: string | undefined;
    url: string | undefined;
    body: string;
}

const reply = (body: unknown, status = 200): Reply => ({ status, body: JSON.stringify(body) });
const software = (extra: object = {}) => ({ id: 'sw-1', '@type': 'SoftwareSpecification', name: 'App', lifecycleStatus: 'Launched', softwareSupportPackage: { id: 'pkg-1' }, relatedParty: [SELLER], ...extra });
const creation = (extra: object = {}) => JSON.stringify({ '@type': 'SoftwareSpecification', name: 'App', resourceCharacteristic: HELM, relatedParty: [SELLER], ...extra });

// What the API says to each request of the proxy
let world: Record<'current' | 'currentPackage' | 'supportSpecs' | 'supportSpecCreate' | 'packageCreate' | 'specCreate' | 'specPatch' | 'packagePatch' | 'packageDelete' | 'dependents' | 'packages', Reply>;
let listDelay: number;
let seen: Seen[];
let app: NestExpressApplication;
let url: string;

const answer = (request: Seen): Reply => {
    const [path = '', query = ''] = (request.url ?? '').slice(BASE.length).split('?');
    if (path === '/resourceSpecification') {
        if (request.method === 'GET') {
            return world.supportSpecs;
        }
        return (JSON.parse(request.body) as { '@type'?: string })['@type'] === SUPPORT_TYPE ? world.supportSpecCreate : world.specCreate;
    }
    if (path === '/resource') {
        return request.method === 'POST' ? world.packageCreate : query.includes('resourceSpecification.id=') ? world.dependents : world.packages;
    }
    if (path.startsWith('/resourceSpecification/')) {
        return request.method === 'GET' ? world.current : world.specPatch;
    }
    return request.method === 'GET' ? world.currentPackage : request.method === 'PATCH' ? world.packagePatch : world.packageDelete;
};

beforeAll(async () => {
    await upstream.start();
    Object.assign(process.env, { BAE_UPSTREAMS__TMFORUM__HOST: '127.0.0.1', BAE_UPSTREAMS__TMFORUM__PORT: String(upstream.port) });
    app = await createApp(Root);
    useFakeLogin(app);
    await app.listen(0);
    url = await app.getUrl();
});

afterAll(async () => {
    await app.close();
    await upstream.stop();
});

beforeEach(() => {
    upstream.reset();
    seen = [];
    listDelay = 0;
    app.get(CatalogDefaults).setSupportPackageSpecId('');
    world = {
        current: reply(software()),
        currentPackage: reply({ id: 'pkg-1', '@type': 'SoftwareSupportPackage', relatedParty: [SELLER] }),
        supportSpecs: reply([{ id: 'spec-global', name: SUPPORT_NAME, '@type': SUPPORT_TYPE }]),
        supportSpecCreate: reply({ id: 'spec-global' }, 201),
        packageCreate: reply({ id: 'pkg-1' }, 201),
        specCreate: reply({ id: 'sw-1' }, 201),
        specPatch: reply({ id: 'sw-1' }),
        packagePatch: reply({ id: 'pkg-1' }),
        packageDelete: { status: 204, body: '' },
        dependents: reply([]),
        packages: reply([])
    };
    upstream.answer((res) => {
        const request = upstream.seen as Seen;
        seen.push({ method: request.method, url: request.url, body: request.body });
        const { status, body } = answer(request);
        const send = () => upstream.json(res, status, body);
        if (listDelay > 0 && request.method === 'GET' && request.url?.includes('@type') === true) {
            setTimeout(send, listDelay);
        } else {
            send();
        }
    });
});

const call = (path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) =>
    fetch(`${url}/software${path}`, { method: init.method ?? 'GET', headers: init.headers ?? {}, ...(init.body === undefined ? {} : { body: init.body }) });
const seller = { ...AS_SELLER, ...JSON_HEADERS };
const steps = (): string[] => seen.map((request) => `${request.method} ${(request.url ?? '').slice(BASE.length).split('?')[0]}`);
const bodyOf = (step: string): unknown => JSON.parse(seen.find((request) => `${request.method} ${(request.url ?? '').slice(BASE.length).split('?')[0]}` === step)?.body ?? 'null');
const create = (body: string) => call('/resourceSpecification', { method: 'POST', headers: seller, body });
const change = (body: string) => call('/resourceSpecification/sw-1', { method: 'PATCH', headers: seller, body });
const retire = (headers: Record<string, string> = AS_SELLER) => call('/resourceSpecification/sw-1', { method: 'DELETE', headers });

describe('the creation of a software specification', () => {
    it('makes its support package from the global specification and gives the specification the package, with the characteristics in it', async () => {
        const res = await create(creation());

        expect(res.status).toBe(201);
        expect(steps()).toEqual(['GET /resourceSpecification', 'POST /resource', 'POST /resourceSpecification']);
        expect(seen[0]?.url).toBe(`${BASE}/resourceSpecification?%40type=${SUPPORT_TYPE}&name=${encodeURIComponent(SUPPORT_NAME).replaceAll('%20', '+')}&limit=100`);
        expect(bodyOf('POST /resource')).toEqual({
            name: 'Software Support Package for App',
            '@type': 'SoftwareSupportPackage',
            '@baseType': 'Resource',
            resourceStatus: 'available',
            usageState: 'active',
            resourceSpecification: { id: 'spec-global' },
            resourceCharacteristic: HELM,
            relatedParty: [NORMALIZED]
        });
        expect(bodyOf('POST /resourceSpecification')).toEqual({ '@type': 'SoftwareSpecification', name: 'App', softwareSupportPackage: { id: 'pkg-1' }, relatedParty: [NORMALIZED] });
    });

    it('creates the global specification the first time, launched', async () => {
        world.supportSpecs = reply([]);
        await create(creation());

        expect(steps()).toEqual(['GET /resourceSpecification', 'POST /resourceSpecification', 'POST /resource', 'POST /resourceSpecification']);
        expect(bodyOf('POST /resourceSpecification')).toMatchObject({ name: SUPPORT_NAME, '@type': SUPPORT_TYPE, lifecycleStatus: 'Launched' });
        expect(JSON.parse(seen[2]?.body ?? 'null')).toMatchObject({ resourceSpecification: { id: 'spec-global' } });
    });

    it('does not take for the global specification one of another name that has its type', async () => {
        world.supportSpecs = reply([{ id: 'spec-of-somebody', name: 'My own package spec', '@type': SUPPORT_TYPE }]);
        await create(creation());

        expect(steps()[1]).toBe('POST /resourceSpecification');
        expect(JSON.parse(seen[2]?.body ?? 'null')).toMatchObject({ resourceSpecification: { id: 'spec-global' } });
    });

    it('makes one global specification when two specifications are created at once', async () => {
        world.supportSpecs = reply([]);
        listDelay = 60;
        const results = await Promise.all([create(creation({ name: 'One' })), create(creation({ name: 'Two' }))]);

        expect(results.map((res) => res.status)).toEqual([201, 201]);
        const globals = seen.filter((request) => request.method === 'POST' && request.url === `${BASE}/resourceSpecification` && request.body.includes(SUPPORT_TYPE));
        expect(globals).toHaveLength(1);
    });

    it('takes the package back when the specification cannot be created, and passes on what the API said', async () => {
        world.specCreate = reply({ error: 'refused' }, 422);
        const res = await create(creation());

        expect(res.status).toBe(422);
        expect(await res.json()).toEqual({ error: 'refused' });
        expect(steps().slice(-2)).toEqual(['POST /resourceSpecification', 'DELETE /resource/pkg-1']);
    });

    it('tells the client what is left when the package cannot be taken back', async () => {
        world.specCreate = reply({ error: 'refused' }, 500);
        world.packageDelete = reply({ error: 'no' }, 500);
        const res = await create(creation());

        expect(res.status).toBe(502);
        expect(await res.json()).toEqual({ error: 'The resource spec could not be created and the support package pkg-1 that was made for it could not be removed' });
    });

    it('does not create the specification when the package cannot be made', async () => {
        world.packageCreate = reply({ error: 'no' }, 500);
        const res = await create(creation());

        expect(res.status).toBe(502);
        expect(await res.json()).toEqual({ error: 'It was impossible to create the software support package' });
        expect(steps()).toEqual(['GET /resourceSpecification', 'POST /resource']);
    });

    it.each([
        ['cannot be looked for', () => (world.supportSpecs = reply({}, 500)), 'It was impossible to check if the software support package spec already exists'],
        [
            'cannot be created',
            () => {
                world.supportSpecs = reply([]);
                world.supportSpecCreate = reply({}, 500);
            },
            'It was impossible to create the software support package spec'
        ]
    ])('does not go on when the global specification %s', async (_name, arrange, error) => {
        arrange();
        const res = await create(creation());

        expect(res.status).toBe(502);
        expect(await res.json()).toEqual({ error });
        expect(steps()).not.toContain('POST /resource');
    });

    it('makes no package for a specification that is not of software, and leaves its characteristics in it', async () => {
        const res = await create(creation({ '@type': 'ResourceSpecification' }));

        expect(res.status).toBe(201);
        expect(steps()).toEqual(['POST /resourceSpecification']);
        expect(bodyOf('POST /resourceSpecification')).toMatchObject({ resourceCharacteristic: HELM });
    });

    it.each([
        ['somebody else as the owner', creation({ relatedParty: [{ id: 'p-other', role: 'Seller' }] }), 403],
        ['two owners', creation({ relatedParty: [SELLER, { id: 'p-other', role: 'Seller' }] }), 403],
        ['no name', JSON.stringify({ '@type': 'SoftwareSpecification', relatedParty: [SELLER] }), 422]
    ])('refuses %s before anything is made', async (_name, body, status) => {
        expect((await create(body)).status).toBe(status);
        expect(seen).toEqual([]);
    });

    it('is for a seller', async () => {
        const res = await call('/resourceSpecification', { method: 'POST', headers: { ...LOGGED_IN, ...JSON_HEADERS }, body: creation({ relatedParty: [{ id: 'p-ana', role: 'Seller' }] }) });
        expect(res.status).toBe(403);
        expect(seen).toEqual([]);
    });
});

describe('the deployment definition', () => {
    it.each([
        ['has no type', [{ name: 'deploymentDefinition', value: { properties: {} } }], 'deploymentDefinition must contain a type and a properties object'],
        ['has no properties', [{ name: 'deploymentDefinition', value: { type: 'docker' } }], 'deploymentDefinition must contain a type and a properties object'],
        ['has properties that are not an object', [{ name: 'deploymentDefinition', value: { type: 'docker', properties: 'x' } }], 'deploymentDefinition must contain a type and a properties object'],
        [
            'is a chart with the name of the release',
            [{ name: 'deploymentDefinition', value: { type: 'helm', properties: { releaseName: 'x', namespace: 'y' } } }],
            'deploymentDefinition.properties must not contain releaseName or namespace: the release identity is chosen per deployment and travels in the deployment order, not in the package'
        ]
    ])('is refused with 422 when it %s, and nothing is made', async (_name, resourceCharacteristic, error) => {
        const res = await create(creation({ resourceCharacteristic }));

        expect(res.status).toBe(422);
        expect(await res.json()).toEqual({ error });
        expect(seen).toEqual([]);
    });

    it.each([
        ['characteristics that are not a list', {}],
        ['a characteristic that is not an object', [null]]
    ])('is refused with 400 for %s', async (_name, resourceCharacteristic) => {
        expect((await create(creation({ resourceCharacteristic }))).status).toBe(400);
        expect(seen).toEqual([]);
    });

    it('lets a docker definition, and characteristics with none, through', async () => {
        expect((await create(creation({ resourceCharacteristic: [{ name: 'deploymentDefinition', value: { type: 'docker', properties: { releaseName: 'fine' } } }] }))).status).toBe(201);
        expect((await create(creation({ resourceCharacteristic: [{ name: 'other', value: 'x' }] }))).status).toBe(201);
    });
});

describe('the change of a software specification', () => {
    it('saves the characteristics in the support package and not in the specification', async () => {
        const res = await change(JSON.stringify({ name: 'Renamed', resourceCharacteristic: HELM }));

        expect(res.status).toBe(200);
        expect(steps()).toEqual(['GET /resourceSpecification/sw-1', 'PATCH /resourceSpecification/sw-1', 'PATCH /resource/pkg-1']);
        expect(bodyOf('PATCH /resourceSpecification/sw-1')).toEqual({ name: 'Renamed' });
        expect(bodyOf('PATCH /resource/pkg-1')).toEqual({ resourceCharacteristic: HELM });
    });

    it('tells the client what was done when the characteristics cannot be saved', async () => {
        world.packagePatch = reply({}, 500);
        const res = await change(JSON.stringify({ resourceCharacteristic: HELM }));

        expect(res.status).toBe(502);
        expect(await res.json()).toEqual({ error: 'The software specification was updated but its characteristics could not be saved in the support package' });
    });

    it('does not touch the package when the specification cannot be changed', async () => {
        world.specPatch = reply({ error: 'refused' }, 422);
        const res = await change(JSON.stringify({ resourceCharacteristic: HELM }));

        expect(res.status).toBe(422);
        expect(steps()).not.toContain('PATCH /resource/pkg-1');
    });

    it('leaves the characteristics in the specification when it has no package or is not of software', async () => {
        world.current = reply(software({ softwareSupportPackage: undefined }));
        await change(JSON.stringify({ resourceCharacteristic: HELM }));
        expect(bodyOf('PATCH /resourceSpecification/sw-1')).toEqual({ resourceCharacteristic: HELM });

        seen = [];
        world.current = reply(software({ '@type': 'ResourceSpecification' }));
        await change(JSON.stringify({ resourceCharacteristic: HELM }));
        expect(steps()).toEqual(['GET /resourceSpecification/sw-1', 'PATCH /resourceSpecification/sw-1']);
    });

    it('checks the deployment definition and the owners, which v11 did not check for software', async () => {
        const definition = await change(JSON.stringify({ resourceCharacteristic: [{ name: 'deploymentDefinition', value: { type: 'helm', properties: { namespace: 'x' } } }] }));
        expect(definition.status).toBe(422);

        const owners = await change(JSON.stringify({ relatedParty: [{ id: 'p-other', role: 'Seller' }] }));
        expect(owners.status).toBe(409);
        expect(steps().filter((step) => step.startsWith('PATCH'))).toEqual([]);
    });

    it('refuses a specification of somebody else', async () => {
        world.current = reply(software({ relatedParty: [{ id: 'p-other', role: 'Seller' }] }));
        expect((await change('{"name":"Mine now"}')).status).toBe(403);
        expect(steps()).toEqual(['GET /resourceSpecification/sw-1']);
    });

    it('is not retired while a resource made from it is not retired, and says which', async () => {
        world.dependents = reply([{ id: 'res-1', lifecycleStatus: 'Launched' }, { id: 'res-2', lifecycleStatus: 'Retired' }, { id: 'res-3' }]);
        const res = await change('{"lifecycleStatus":"Retired"}');

        expect(res.status).toBe(409);
        expect(await res.json()).toEqual({ error: 'Cannot retire a resource spec without retiring all resources linked with it (blocked by resources res-1, res-3)' });
        expect(seen[1]?.url).toBe(`${BASE}/resource?resourceSpecification.id=sw-1&fields=lifecycleStatus&limit=100&offset=0`);
        expect(steps()).not.toContain('PATCH /resourceSpecification/sw-1');
    });
});

describe('the retirement of a software specification', () => {
    it('suspends the support package and then retires the specification', async () => {
        const res = await retire();

        expect(res.status).toBe(200);
        expect(steps()).toEqual(['GET /resourceSpecification/sw-1', 'GET /resource', 'PATCH /resource/pkg-1', 'PATCH /resourceSpecification/sw-1']);
        expect(bodyOf('PATCH /resource/pkg-1')).toEqual({ resourceStatus: 'suspended', usageState: 'idle' });
        expect(bodyOf('PATCH /resourceSpecification/sw-1')).toEqual({ lifecycleStatus: 'Retired' });
    });

    it('makes the package available again when the specification cannot be retired, and passes on what the API said', async () => {
        world.specPatch = reply({ error: 'refused' }, 500);
        const res = await retire();

        expect(res.status).toBe(500);
        expect(steps().slice(-2)).toEqual(['PATCH /resourceSpecification/sw-1', 'PATCH /resource/pkg-1']);
        expect(JSON.parse(seen.at(-1)?.body ?? 'null')).toEqual({ resourceStatus: 'available', usageState: 'active' });
    });

    it('tells the client what is left when the package cannot be made available again', async () => {
        let packagePatches = 0;
        world.specPatch = reply({ error: 'refused' }, 500);
        upstream.answer((res) => {
            const request = upstream.seen as Seen;
            seen.push({ method: request.method, url: request.url, body: request.body });
            const failing = request.method === 'PATCH' && request.url?.includes('/resource/') === true && (packagePatches += 1) > 1;
            const { status, body } = failing ? reply({}, 500) : answer(request);
            upstream.json(res, status, body);
        });
        const res = await retire();

        expect(res.status).toBe(502);
        expect(await res.json()).toEqual({ error: 'The resource spec could not be retired and the support package pkg-1 could not be made available again' });
    });

    it('does not retire the specification when the package cannot be suspended', async () => {
        world.packagePatch = reply({}, 500);
        const res = await retire();

        expect(res.status).toBe(502);
        expect(await res.json()).toEqual({ error: 'It was impossible to retire the linked software support package' });
        expect(steps()).not.toContain('PATCH /resourceSpecification/sw-1');
    });

    it('retires a specification that has no package', async () => {
        world.current = reply(software({ softwareSupportPackage: undefined }));
        expect((await retire()).status).toBe(200);
        expect(steps()).toEqual(['GET /resourceSpecification/sw-1', 'GET /resource', 'PATCH /resourceSpecification/sw-1']);
    });

    it('waits for the resources that are made from it', async () => {
        world.dependents = reply([{ id: 'res-1', lifecycleStatus: 'Launched' }]);
        const res = await retire();

        expect(res.status).toBe(409);
        expect(steps()).not.toContain('PATCH /resource/pkg-1');
    });
});

describe('the specifications as the portal reads them', () => {
    it('are listed for the seller, with the party and its role added last', async () => {
        await call('/resourceSpecification?%40type=SoftwareSpecification&lifecycleStatus=Active&relatedParty.id=p-victim', { headers: AS_SELLER });
        expect([...new URL(`http://x${seen[0]?.url ?? ''}`).searchParams.entries()]).toEqual([
            ['@type', 'SoftwareSpecification'],
            ['lifecycleStatus', 'Active'],
            ['relatedParty.id', 'p-shop'],
            ['relatedParty.role', 'Seller']
        ]);
        expect((await call('/resourceSpecification')).status).toBe(401);
    });

    it('are read by anybody when they are not a draft, and by their owner before', async () => {
        expect((await call('/resourceSpecification/sw-1')).status).toBe(200);
        world.current = reply(software({ lifecycleStatus: 'Active' }));
        expect((await call('/resourceSpecification/sw-1')).status).toBe(403);
        expect((await call('/resourceSpecification/sw-1', { headers: AS_SELLER })).status).toBe(200);
    });
});

describe('the support packages', () => {
    const owned = { id: 'pkg-1', '@type': 'SoftwareSupportPackage', relatedParty: [SELLER] };

    it('are listed for the seller who owns them', async () => {
        await call('/resource?resourceStatus=available&%40type=SoftwareSupportPackage&limit=6&relatedParty.id=p-victim', { headers: AS_SELLER });
        expect([...new URL(`http://x${seen[0]?.url ?? ''}`).searchParams.entries()].slice(-2)).toEqual([
            ['relatedParty.id', 'p-shop'],
            ['relatedParty.role', 'Seller']
        ]);
        expect((await call('/resource')).status).toBe(401);
    });

    it('are read only by their owner, whatever state they say, and not kept by a cache', async () => {
        world.currentPackage = reply({ ...owned, lifecycleStatus: 'Launched' });
        const mine = await call('/resource/pkg-1', { headers: AS_SELLER });
        expect(mine.status).toBe(200);
        expect(mine.headers.get('cache-control')).toBe('private, no-store');

        expect((await call('/resource/pkg-1', { headers: LOGGED_IN })).status).toBe(403);
        expect((await call('/resource/pkg-1')).status).toBe(401);
    });

    it('are created by a seller as their own, with the deployment definition checked', async () => {
        const body = JSON.stringify({ name: 'Package', '@type': 'SoftwareSupportPackage', resourceCharacteristic: HELM, relatedParty: [SELLER] });
        const res = await call('/resource', { method: 'POST', headers: seller, body });

        expect(res.status).toBe(201);
        expect(steps()).toEqual(['POST /resource']);
        expect(bodyOf('POST /resource')).toMatchObject({ name: 'Package', relatedParty: [NORMALIZED] });

        const bad = await call('/resource', { method: 'POST', headers: seller, body: JSON.stringify({ name: 'Package', resourceCharacteristic: [{ name: 'deploymentDefinition', value: {} }], relatedParty: [SELLER] }) });
        expect(bad.status).toBe(422);
    });

    it('are changed by their owner after reading them, and never by somebody else', async () => {
        world.currentPackage = reply(owned);
        expect((await call('/resource/pkg-1', { method: 'PATCH', headers: seller, body: JSON.stringify({ resourceCharacteristic: HELM }) })).status).toBe(200);
        expect(steps()).toEqual(['GET /resource/pkg-1', 'PATCH /resource/pkg-1']);

        seen = [];
        world.currentPackage = reply({ ...owned, relatedParty: [{ id: 'p-other', role: 'Seller' }] });
        expect((await call('/resource/pkg-1', { method: 'PATCH', headers: seller, body: '{"name":"x"}' })).status).toBe(403);
        expect(steps()).toEqual(['GET /resource/pkg-1']);
    });
});

describe('the rest of /software', () => {
    it.each([
        ['DELETE', '/resource/pkg-1'],
        ['PUT', '/resource/pkg-1'],
        ['PUT', '/resourceSpecification/sw-1'],
        ['POST', '/resource/pkg-1'],
        ['POST', '/resourceSpecification/sw-1'],
        ['DELETE', '/resourceSpecification'],
        ['PATCH', '/resource'],
        ['GET', '/resource/pkg-1/history'],
        ['GET', '/other'],
        ['GET', '']
    ])('%s %s is not found, and nothing is written', async (method, path) => {
        const res = await call(path, { method, headers: seller, ...(method === 'GET' ? {} : { body: '{"name":"x"}' }) });
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: 'Not found' });
        expect(seen).toEqual([]);
    });
});

describe('the support package spec that the start-up found', () => {
    it('is the one every support package is made from, without looking for it', async () => {
        app.get(CatalogDefaults).setSupportPackageSpecId('spec-known');

        const res = await create(creation());

        expect(res.status).toBe(201);
        expect(steps()).toEqual(['POST /resource', 'POST /resourceSpecification']);
        expect((bodyOf('POST /resource') as { resourceSpecification: unknown }).resourceSpecification).toEqual({ id: 'spec-known' });
    });

    it('is remembered when the spec is found or made the first time, so the next one does not look for it', async () => {
        await create(creation());
        seen = [];
        await create(creation());

        expect(app.get(CatalogDefaults).supportPackageSpecId).toBe('spec-global');
        expect(steps()).toEqual(['POST /resource', 'POST /resourceSpecification']);
    });

    it('is forgotten when it is not in the software API any more, and found again', async () => {
        app.get(CatalogDefaults).setSupportPackageSpecId('spec-gone');
        let attempts = 0;
        Object.defineProperty(world, 'packageCreate', { get: () => (attempts++ === 0 ? reply({}, 400) : reply({ id: 'pkg-1' }, 201)), configurable: true, enumerable: true });
        world.current = reply({}, 404);

        const res = await create(creation());

        expect(res.status).toBe(201);
        expect(steps()).toEqual(['POST /resource', 'GET /resourceSpecification/spec-gone', 'GET /resourceSpecification', 'POST /resource', 'POST /resourceSpecification']);
        expect(app.get(CatalogDefaults).supportPackageSpecId).toBe('spec-global');
    });

    it('is kept when the package fails for another reason', async () => {
        app.get(CatalogDefaults).setSupportPackageSpecId('spec-known');
        world.packageCreate = reply({}, 500);

        const res = await create(creation());

        expect(res.status).toBe(502);
        expect(steps()).toEqual(['POST /resource', 'GET /resourceSpecification/spec-known']);
        expect(app.get(CatalogDefaults).supportPackageSpecId).toBe('spec-known');
    });
});
