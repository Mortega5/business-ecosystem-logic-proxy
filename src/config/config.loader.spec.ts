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

    it('requires the contract definition schema when dsp is enabled', () => {
        expect(() => load({ BAE_DSP__ENABLED: 'true' })).toThrow('dsp.contractDefinitionSchema');
        expect(
            load({ BAE_DSP__ENABLED: 'true', BAE_DSP__CONTRACT_DEFINITION_SCHEMA: 'https://schemas.example.org/dsp.json' })
                .dsp.enabled
        ).toBe(true);
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
