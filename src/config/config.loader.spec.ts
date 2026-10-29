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
        expect(config.app.host).toBe('0.0.0.0');
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

    it('reads an upstream from environment variables', () => {
        const config = loadStaticConfig({
            defaultsPath: DEFAULTS_PATH,
            env: {
                BAE_UPSTREAMS__CATALOG__BASE_URL: 'http://catalog:8080/tmf-api',
                BAE_UPSTREAMS__CATALOG__TIMEOUT_MS: '2500'
            }
        });
        expect(config.upstreams.catalog).toEqual({ baseUrl: 'http://catalog:8080/tmf-api', timeoutMs: 2500 });
    });

    it('rejects an upstream without a valid base url', () => {
        expect(() =>
            loadStaticConfig({
                defaultsPath: DEFAULTS_PATH,
                env: { BAE_UPSTREAMS__CATALOG__BASE_URL: 'not a url', BAE_UPSTREAMS__CATALOG__TIMEOUT_MS: '1' }
            })
        ).toThrow('upstreams.catalog.baseUrl');
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
