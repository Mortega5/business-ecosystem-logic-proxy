import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    DEFAULT_APPLICATION_PATH,
    deepMerge,
    envToObject,
    loadStaticConfig,
    parseConfig,
    readYamlFile,
    resolveApplicationPath
} from './config.loader';

const DEFAULTS_PATH = join(__dirname, '../../config/default.yaml');

const writeYaml = (content: string): string => {
    const path = join(mkdtempSync(join(tmpdir(), 'bae-config-')), 'application.yaml');
    writeFileSync(path, content);
    return path;
};

describe('deepMerge', () => {
    it('merges nested objects and replaces arrays', () => {
        const merged = deepMerge({ a: { b: 1, c: 2 }, list: [1, 2] }, { a: { c: 3 }, list: [9] });
        expect(merged).toEqual({ a: { b: 1, c: 3 }, list: [9] });
    });

    it('does not mutate its inputs', () => {
        const base = { a: { b: 1 } };
        deepMerge(base, { a: { b: 2 } });
        expect(base).toEqual({ a: { b: 1 } });
    });

    it('ignores keys that could pollute prototypes', () => {
        const merged = deepMerge({}, JSON.parse('{"__proto__": {"polluted": true}}') as Record<string, unknown>);
        expect(({} as Record<string, unknown>).polluted).toBeUndefined();
        expect(Object.keys(merged)).toEqual([]);
    });
});

describe('envToObject', () => {
    it('maps double underscores to nesting and single ones to camelCase', () => {
        expect(envToObject({ BAE_APP__SHUTDOWN_TIMEOUT_MS: '5000', BAE_MONGO__URI: 'mongodb://x' })).toEqual({
            app: { shutdownTimeoutMs: '5000' },
            mongo: { uri: 'mongodb://x' }
        });
    });

    it('parses JSON arrays and objects', () => {
        expect(envToObject({ BAE_HTTP__TRUSTED_PROXIES: '["10.0.0.0/8"]' })).toEqual({
            http: { trustedProxies: ['10.0.0.0/8'] }
        });
    });

    it('ignores unrelated and legacy variables', () => {
        expect(envToObject({ PATH: '/bin', BAE_LP_PORT: '8004', BAE_SERVICE_HOST: 'x' })).toEqual({});
    });

    it('skips forbidden path segments', () => {
        expect(envToObject({ BAE___PROTO____POLLUTED: '1' })).toEqual({});
    });
});

describe('readYamlFile', () => {
    it('fails with the path when the file is missing', () => {
        expect(() => readYamlFile('/does/not/exist.yaml')).toThrow('/does/not/exist.yaml');
    });

    it('rejects a top level that is not a mapping', () => {
        expect(() => readYamlFile(writeYaml('- a\n- b\n'))).toThrow('mapping');
    });

    it('treats an empty file as an empty config', () => {
        expect(readYamlFile(writeYaml(''))).toEqual({});
    });
});

describe('parseConfig', () => {
    it('lists every invalid field', () => {
        expect(() => parseConfig({ app: { port: 'abc' } })).toThrow(/app\.port[\s\S]*mongo/);
    });
});

describe('resolveApplicationPath', () => {
    it('prefers CONFIG_FILE even when it does not exist', () => {
        expect(resolveApplicationPath({ CONFIG_FILE: '/custom/app.yaml' }, () => false)).toBe('/custom/app.yaml');
    });

    it('falls back to the default location when a file is mounted there', () => {
        expect(resolveApplicationPath({}, (path) => path === DEFAULT_APPLICATION_PATH)).toBe(
            '/etc/bae/config/application.yaml'
        );
    });

    it('uses no application file when nothing is mounted', () => {
        expect(resolveApplicationPath({}, () => false)).toBeUndefined();
        expect(resolveApplicationPath({ CONFIG_FILE: '' }, () => false)).toBeUndefined();
    });
});

describe('loadStaticConfig', () => {
    it('accepts the shipped defaults', () => {
        const config = loadStaticConfig({ defaultsPath: DEFAULTS_PATH, env: {} });
        expect(config.app.port).toBe(8004);
        expect(config.logging.format).toBe('pretty');
    });

    it('applies the application file over the defaults', () => {
        const applicationPath = writeYaml('app:\n  port: 9000\nlogging:\n  format: json\n');
        const config = loadStaticConfig({ defaultsPath: DEFAULTS_PATH, applicationPath, env: {} });
        expect(config.app.port).toBe(9000);
        expect(config.app.host).toBeUndefined();
        expect(config.logging.format).toBe('json');
    });

    it('applies environment variables over the application file', () => {
        const applicationPath = writeYaml('app:\n  port: 9000\n');
        const config = loadStaticConfig({
            defaultsPath: DEFAULTS_PATH,
            applicationPath,
            env: { BAE_APP__PORT: '9100', BAE_HTTP__TRUSTED_PROXIES: '["loopback"]' }
        });
        expect(config.app.port).toBe(9100);
        expect(config.http.trustedProxies).toEqual(['loopback']);
    });

    describe('legacy variables', () => {
        it('apply over the defaults and report each variable they used', () => {
            const used: string[] = [];
            const config = loadStaticConfig({
                defaultsPath: DEFAULTS_PATH,
                env: { BAE_LP_PORT: '9000', BAE_LP_MONGO_SERVER: 'db.internal', BAE_LP_MONGO_DB: 'bae' },
                onLegacyVariable: ({ variable }) => used.push(variable)
            });

            expect(config.app.port).toBe(9000);
            expect(config.mongo.uri).toBe('mongodb://db.internal:27017/bae');
            expect(used).toEqual(['BAE_LP_PORT', 'BAE_LP_MONGO_SERVER', 'BAE_LP_MONGO_DB']);
        });

        it('lose against the application file, which loses against the new variables', () => {
            const applicationPath = writeYaml('app:\n  port: 9100\n');

            const fromFile = loadStaticConfig({ defaultsPath: DEFAULTS_PATH, applicationPath, env: { BAE_LP_PORT: '9000' } });
            const fromEnv = loadStaticConfig({
                defaultsPath: DEFAULTS_PATH,
                applicationPath,
                env: { BAE_LP_PORT: '9000', BAE_APP__PORT: '9200' }
            });

            expect(fromFile.app.port).toBe(9100);
            expect(fromEnv.app.port).toBe(9200);
        });
    });

    it('has HTTPS disabled by default and requires a key and a certificate once enabled', () => {
        expect(loadStaticConfig({ defaultsPath: DEFAULTS_PATH, env: {} }).app.https).toEqual({ enabled: false });
        expect(() => loadStaticConfig({ defaultsPath: DEFAULTS_PATH, env: { BAE_APP__HTTPS__ENABLED: 'true' } })).toThrow(
            /app\.https\.keyFile: is required[\s\S]*app\.https\.certFile: is required/
        );
        expect(
            loadStaticConfig({
                defaultsPath: DEFAULTS_PATH,
                env: { BAE_APP__HTTPS__ENABLED: 'true', BAE_APP__HTTPS__KEY_FILE: '/k', BAE_APP__HTTPS__CERT_FILE: '/c' }
            }).app.https
        ).toEqual({ enabled: true, keyFile: '/k', certFile: '/c' });
    });

    it('reads the string "false" for app.https.enabled as false', () => {
        const config = loadStaticConfig({ defaultsPath: DEFAULTS_PATH, env: { BAE_APP__HTTPS__ENABLED: 'false' } });
        expect(config.app.https.enabled).toBe(false);
    });

    it('defaults to no shutdown delay and a timeout that leaves room for one', () => {
        const config = loadStaticConfig({ defaultsPath: DEFAULTS_PATH, env: {} });
        expect(config.app).toMatchObject({ shutdownDelayMs: 0, shutdownTimeoutMs: 20000 });
    });

    it('rejects a shutdown delay that is not shorter than the shutdown timeout', () => {
        expect(() =>
            loadStaticConfig({
                defaultsPath: DEFAULTS_PATH,
                env: { BAE_APP__SHUTDOWN_DELAY_MS: '20000', BAE_APP__SHUTDOWN_TIMEOUT_MS: '20000' }
            })
        ).toThrow('app.shutdownTimeoutMs: must be greater than app.shutdownDelayMs');
    });

    it('reads an upstream from environment variables', () => {
        const config = loadStaticConfig({
            defaultsPath: DEFAULTS_PATH,
            env: {
                BAE_UPSTREAMS__CHARGING__HOST: 'charging',
                BAE_UPSTREAMS__CHARGING__PORT: '8006',
                BAE_UPSTREAMS__CHARGING__TIMEOUT_MS: '2500'
            }
        });
        expect(config.upstreams.charging).toEqual({ host: 'charging', port: 8006, timeoutMs: 2500 });
    });

    it('rejects an upstream with a scheme or a port inside the host, or a port out of range', () => {
        const load = (env: NodeJS.ProcessEnv) => () => loadStaticConfig({ defaultsPath: DEFAULTS_PATH, env });
        expect(load({ BAE_UPSTREAMS__CHARGING__HOST: 'http://charging' })).toThrow('upstreams.charging.host');
        expect(load({ BAE_UPSTREAMS__CHARGING__HOST: 'charging:8006' })).toThrow('upstreams.charging.host');
        expect(load({ BAE_UPSTREAMS__CHARGING__PORT: '70000' })).toThrow('upstreams.charging.port');
        expect(load({ BAE_UPSTREAMS__CHARGING__SCHEME: 'ftp' })).toThrow('upstreams.charging.scheme');
    });

    it('rejects an API that does not exist in a group', () => {
        expect(() =>
            loadStaticConfig({
                defaultsPath: DEFAULTS_PATH,
                env: { BAE_UPSTREAMS__TMFORUM__APIS__CATALOGUE__HOST: 'tmforum' }
            })
        ).toThrow('upstreams.tmforum.apis');
    });

    it('fails to start with an unreadable application file', () => {
        expect(() =>
            loadStaticConfig({ defaultsPath: DEFAULTS_PATH, applicationPath: '/missing.yaml', env: {} })
        ).toThrow('/missing.yaml');
    });

    it('fails to start with an invalid value', () => {
        expect(() => loadStaticConfig({ defaultsPath: DEFAULTS_PATH, env: { BAE_LOGGING__FORMAT: 'xml' } })).toThrow(
            'logging.format'
        );
    });
});

describe('feature configuration', () => {
    const load = (env: NodeJS.ProcessEnv) => loadStaticConfig({ defaultsPath: DEFAULTS_PATH, env });

    it('starts with the defaults and no payment gateway', () => {
        const config = load({});
        expect(config.purchase).toEqual({ enabled: true, paymentProvider: 'none' });
        expect(config.catalog.offeringSchema).toMatch(/^https:/);
    });

    it('requires a payment gateway for the dpas provider', () => {
        expect(() => load({ BAE_PURCHASE__PAYMENT_PROVIDER: 'dpas' })).toThrow('purchase.paymentGateway');
        expect(
            load({ BAE_PURCHASE__PAYMENT_PROVIDER: 'dpas', BAE_PURCHASE__PAYMENT_GATEWAY: 'https://pay.example.org' })
                .purchase.paymentGateway
        ).toBe('https://pay.example.org');
    });

    it('has the schema of the EDC contract definition by default, so that dsp can be turned on, and it can be changed and has to be a URL', () => {
        const byDefault = 'https://raw.githubusercontent.com/wistefan/edc-dsc/refs/heads/init/schemas/contract-definition.json';

        expect(load({}).dsp.contractDefinitionSchema).toBe(byDefault);
        expect(load({ BAE_DSP__ENABLED: 'true' }).dsp).toEqual({ enabled: true, contractDefinitionSchema: byDefault });
        expect(load({ BAE_DSP__CONTRACT_DEFINITION_SCHEMA: 'https://schemas.example.org/dsp.json' }).dsp.contractDefinitionSchema).toBe('https://schemas.example.org/dsp.json');
        expect(load({ BAE_LP_DSP_CONTRACT_DEFINITION_SCHEMA: 'https://schemas.example.org/legacy.json' }).dsp.contractDefinitionSchema).toBe('https://schemas.example.org/legacy.json');
        expect(() => load({ BAE_DSP__CONTRACT_DEFINITION_SCHEMA: 'not a url' })).toThrow('dsp.contractDefinitionSchema');
    });

    it('accepts the legacy variables and reads anything but "true" as off', () => {
        const config = load({
            BAE_LP_PURCHASE_ENABLED: 'no',
            BAE_LP_PAYMENT_PROVIDER: 'PayPal',
            BAE_LP_QUOTE_API: '/quotes'
        });
        expect(config.purchase).toEqual({ enabled: false, paymentProvider: 'paypal' });
        expect(config.quotes.api).toBe('/quotes');
    });
});

describe('authentication configuration', () => {
    const load = (env: NodeJS.ProcessEnv) => loadStaticConfig({ defaultsPath: DEFAULTS_PATH, env });

    it('keeps the legacy roles and options by default', () => {
        expect(load({}).auth).toEqual({
            propagateToken: true,
            allowLocalEori: false,
            roles: { admin: 'admin', customer: 'Buyer', seller: 'Seller', orgAdmin: 'orgAdmin' },
            replacedTokenGraceMs: 30000,
            idpTimeoutMs: 10000,
            idp: { provider: 'fiware', oidcEnabled: true },
            profileTtlMs: 7200000,
            refreshMarginSeconds: 5,
            defaultTokenLifetimeSeconds: 1800,
            store: { type: 'memory', memoryMaxEntries: 1000 }
        });
    });

    it('reads the main identity provider from the variables of v11', () => {
        expect(load({ BAE_LP_OAUTH2_PROVIDER: 'github', BAE_LP_OAUTH2_CLIENT_ID: 'id' }).auth.idp).toEqual({ provider: 'github', clientId: 'id', oidcEnabled: true });
        expect(
            load({
                BAE_LP_OAUTH2_PROVIDER: 'keycloak',
                BAE_LP_OAUTH2_SERVER: 'https://kc.example.org',
                BAE_LP_OAUTH2_CLIENT_ID: 'bae',
                BAE_LP_OAUTH2_CLIENT_SECRET: 'secret',
                BAE_LP_OAUTH2_CALLBACK: 'https://bae.example.org/auth/keycloak/callback',
                BAE_LP_OIDC_REALM: 'dome'
            }).auth.idp
        ).toMatchObject({ provider: 'keycloak', realm: 'dome', clientId: 'bae' });
        expect(load({ BAE_LP_OIDC_KEY: 'k'.repeat(16), BAE_LP_OIDC_ENABLED: 'false', BAE_LP_OAUTH2_DEFAULT_ROLE: 'Seller' }).auth.idp).toEqual({
            provider: 'fiware',
            oidcEnabled: false,
            oidcKey: 'k'.repeat(16),
            defaultRole: 'Seller'
        });
        expect(() => load({ BAE_LP_OIDC_KEY: 'short' })).toThrow(/oidcKey/);
        expect(() => load({ BAE_LP_OAUTH2_PROVIDER: 'unknown' })).toThrow(/provider/);
    });

    it('lets the times of the tokens be changed', () => {
        const auth = load({
            BAE_AUTH__REPLACED_TOKEN_GRACE_MS: '5000',
            BAE_AUTH__PROFILE_TTL_MS: '60000',
            BAE_AUTH__REFRESH_MARGIN_SECONDS: '15',
            BAE_AUTH__DEFAULT_TOKEN_LIFETIME_SECONDS: '600'
        }).auth;

        expect([auth.replacedTokenGraceMs, auth.profileTtlMs, auth.refreshMarginSeconds, auth.defaultTokenLifetimeSeconds]).toEqual([5000, 60000, 15, 600]);
        expect(() => load({ BAE_AUTH__PROFILE_TTL_MS: '0' })).toThrow(/profileTtlMs/);
    });

    it('keeps the profiles in memory unless MongoDB is chosen, and then asks for the key that seals them', () => {
        expect(() => load({ BAE_AUTH__STORE__TYPE: 'mongo' })).toThrow(/auth\.store\.encryptionKey/);
        expect(() => load({ BAE_AUTH__STORE__TYPE: 'mongo', BAE_AUTH__STORE__ENCRYPTION_KEY: 'short' })).toThrow(/encryptionKey/);
        const key = 'k'.repeat(32);
        expect(load({ BAE_AUTH__STORE__TYPE: 'mongo', BAE_AUTH__STORE__ENCRYPTION_KEY: key }).auth.store).toEqual({
            type: 'mongo',
            memoryMaxEntries: 1000,
            encryptionKey: key
        });
        expect(load({ BAE_AUTH__STORE__MEMORY_MAX_ENTRIES: '50' }).auth.store.memoryMaxEntries).toBe(50);
    });

    it('accepts the legacy variables', () => {
        const { auth } = load({
            BAE_LP_PROPAGATE_TOKEN: 'false',
            BAE_LP_ALLOW_LOCAL_EORI: 'true',
            BAE_LP_OAUTH2_SELLER_ROLE: 'provider',
            BAE_LP_OAUTH2_ORG_ADMIN_ROLE: 'organisation-admin'
        });
        expect(auth).toMatchObject({ propagateToken: false, allowLocalEori: true });
        expect(auth.roles).toMatchObject({ seller: 'provider', orgAdmin: 'organisation-admin', admin: 'admin' });
    });
});

describe('request size configuration', () => {
    const load = (env: NodeJS.ProcessEnv) => loadStaticConfig({ defaultsPath: DEFAULTS_PATH, env });

    it('has a limit for a body and a larger one for an upload', () => {
        expect(load({}).http).toMatchObject({ bodyLimit: '5mb', uploadLimit: '50mb' });
        expect(load({ BAE_HTTP__UPLOAD_LIMIT: '100mb' }).http.uploadLimit).toBe('100mb');
    });

    it('takes the links of the portal from the legacy variables, and anything else it sends from portal.extra', () => {
        const config = load({ BAE_LP_CHAT_URL: 'https://chat.example.org', BAE_LP_THEME: 'dark', BAE_PORTAL__EXTRA__DOME_ABOUT: 'https://about.example.org', BAE_PORTAL__EXTRA__SIOP: '{"enabled":true}' });

        expect(config.portal).toMatchObject({ chatUrl: 'https://chat.example.org', knowledgeBaseUrl: '', ticketingUrl: '', matomoId: '', matomoUrl: '', googleTagManagerId: '', theme: 'dark', extra: { domeAbout: 'https://about.example.org', siop: { enabled: true } } });
    });

    // TO REMOVE with the variables themselves (see legacy-env.ts)
    it('still reads the variables of the portal that are not the core\'s into portal.extra, until they are removed', () => {
        const config = load({
            BAE_LP_DOME_TRUST: 'https://trust.example.org',
            BAE_LP_DOME_ABOUT: 'https://about.example.org',
            BAE_LP_DOME_REGISTER: 'https://register.example.org',
            BAE_LP_DOME_PUBLISH: 'https://publish.example.org',
            BAE_LP_LEAR_URL: 'https://lear.example.org',
            BAE_LP_OAUTH2_ORG_CERTIFIER_ROLE: 'certifier'
        });

        expect(config.portal.extra).toEqual({
            domeTrust: 'https://trust.example.org',
            domeAbout: 'https://about.example.org',
            domeRegister: 'https://register.example.org',
            domeRegisterCustomer: 'https://register.example.org',
            domePublish: 'https://publish.example.org',
            learUrl: 'https://lear.example.org',
            roles: { certifier: 'certifier' }
        });
        // The addresses that v11 gave by default, when there is no variable
        expect(load({}).portal.extra).toEqual({
            domeAbout: 'https://dome-marketplace.eu/about/',
            domeRegister: 'https://dome-marketplace.github.io/onboarding/',
            domeRegisterCustomer: 'https://dome-marketplace.github.io/onboarding/',
            domePublish: 'https://knowledgebase.dome-marketplace.org/shelves/company-onboarding-process'
        });
        expect(load({ BAE_LP_DOME_REGISTER: 'https://a', BAE_LP_DOME_REGISTER_CUSTOMER: 'https://b' }).portal.extra).toMatchObject({ domeRegister: 'https://a', domeRegisterCustomer: 'https://b' });
        // What is set in portal.extra wins over the legacy variable
        expect(load({ BAE_LP_DOME_ABOUT: 'https://old', BAE_PORTAL__EXTRA__DOME_ABOUT: 'https://new' }).portal.extra).toMatchObject({ domeAbout: 'https://new' });
    });

    it('keeps the figures of the landing page for a day, waits ten minutes after a read that failed, and can change them', () => {
        expect(load({}).stats).toEqual({ ttlMs: 86400000, retryDelayMs: 600000, providerTtlMs: 60000 });
        expect(load({ BAE_STATS__TTL_MS: '3600000' }).stats.ttlMs).toBe(3600000);
        expect(() => load({ BAE_STATS__RETRY_DELAY_MS: '0' })).toThrow('stats.retryDelayMs');
    });

    it('has a default for each limit of what is taken or read at once, that can be changed and has to be a positive number', () => {
        expect(load({}).limits).toEqual({ orderItems: 50, cartItems: 100, noteLength: 10000, notesPerRequest: 20, nameLength: 100, descriptionLength: 100000, plansPerQuery: 20, providersPerQuery: 50, providerCacheMs: 300000, readAll: { pageSize: 100, maxPages: 100 } });
        expect(load({ BAE_LIMITS__ORDER_ITEMS: '200' }).limits.orderItems).toBe(200);
        expect(load({ BAE_LIMITS__READ_ALL__PAGE_SIZE: '50' }).limits.readAll.pageSize).toBe(50);
        expect(() => load({ BAE_LIMITS__NAME_LENGTH: '0' })).toThrow('limits.nameLength');
        expect(() => load({ BAE_LIMITS__READ_ALL__MAX_PAGES: 'many' })).toThrow('limits.readAll.maxPages');
    });

    it('makes sure of the platform at start-up unless it is turned off, with the records and the categories of v11 by default', () => {
        const { catalog } = load({});

        expect(catalog.bootstrap).toEqual({ enabled: true, retryDelayMs: 5000, records: { defaultCatalog: 'default', supportPackageSpec: 'global' } });
        expect(catalog.defaultCatalogId).toBe('');
        expect(catalog.defaultCatalogName).toBe('default');
        expect(catalog.systemCategories.map((category) => category.key)).toEqual(['dataset', 'api', 'blueprint']);
        expect(load({ BAE_CATALOG__BOOTSTRAP__ENABLED: 'false' }).catalog.bootstrap.enabled).toBe(false);
        expect(load({ BAE_CATALOG__BOOTSTRAP__ENABLED: 'true' }).catalog.bootstrap.enabled).toBe(true);
    });

    it('lets each of its settings be set, and refuses the ones that are not valid', () => {
        const set = load({ BAE_CATALOG__BOOTSTRAP__RETRY_DELAY_MS: '250', BAE_CATALOG__BOOTSTRAP__RECORDS__DEFAULT_CATALOG: 'main', BAE_CATALOG__BOOTSTRAP__RECORDS__SUPPORT_PACKAGE_SPEC: 'spec' }).catalog.bootstrap;

        expect(set).toMatchObject({ retryDelayMs: 250, records: { defaultCatalog: 'main', supportPackageSpec: 'spec' } });
        expect(() => load({ BAE_CATALOG__BOOTSTRAP__RETRY_DELAY_MS: '0' })).toThrow('catalog.bootstrap.retryDelayMs');
        expect(() => load({ BAE_CATALOG__BOOTSTRAP__RECORDS__DEFAULT_CATALOG: '' })).toThrow('catalog.bootstrap.records.defaultCatalog');
        expect(() => load({ BAE_CATALOG__PARTY_LOCATION: 'not a url' })).toThrow('catalog.partyLocation');
    });

    it('refuses an upload limit that is not a size', () => {
        expect(() => load({ BAE_HTTP__UPLOAD_LIMIT: 'big' })).toThrow('http.uploadLimit');
        expect(() => load({ BAE_HTTP__UPLOAD_LIMIT: '50' })).toThrow('http.uploadLimit');
    });
});
