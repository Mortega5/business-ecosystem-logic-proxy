import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadStaticConfig } from './config.loader';
import { resolveUpstream } from './upstream-resolution';

const DEFAULTS_PATH = join(__dirname, '../../config/default.yaml');
const upstreams = (env: NodeJS.ProcessEnv) => loadStaticConfig({ defaultsPath: DEFAULTS_PATH, env }).upstreams;

describe('resolveUpstream', () => {
    it('gives every API of a single server its own path under the group host and port', () => {
        const config = upstreams({ BAE_UPSTREAMS__TMFORUM__HOST: 'tm-forum-api-svc', BAE_UPSTREAMS__TMFORUM__PORT: '8080' });
        expect(resolveUpstream(config, 'tmforum.catalog')).toEqual({
            baseUrl: 'http://tm-forum-api-svc:8080/tmf-api/productCatalogManagement/v4',
            timeoutMs: 30000
        });
        expect(resolveUpstream(config, 'tmforum.customerBill').baseUrl).toBe(
            'http://tm-forum-api-svc:8080/tmf-api/customerBillManagement/v4'
        );
    });

    it('lets an API override any of host, port, scheme, path and timeout, keeping the rest from the group', () => {
        const config = upstreams({
            BAE_UPSTREAMS__TMFORUM__HOST: 'tm-forum-api-svc',
            BAE_UPSTREAMS__TMFORUM__PORT: '8080',
            BAE_UPSTREAMS__TMFORUM__TIMEOUT_MS: '5000',
            BAE_UPSTREAMS__TMFORUM__APIS__QUOTE__HOST: 'quote',
            BAE_UPSTREAMS__TMFORUM__APIS__QUOTE__PORT: '8085',
            BAE_UPSTREAMS__TMFORUM__APIS__PARTY__PORT: '9090',
            BAE_UPSTREAMS__TMFORUM__APIS__USAGE__SCHEME: 'https',
            BAE_UPSTREAMS__TMFORUM__APIS__CUSTOMER__TIMEOUT_MS: '20000'
        });
        expect(resolveUpstream(config, 'tmforum.quote')).toEqual({ baseUrl: 'http://quote:8085', timeoutMs: 5000 });
        expect(resolveUpstream(config, 'tmforum.party').baseUrl).toBe('http://tm-forum-api-svc:9090/tmf-api/party/v4');
        expect(resolveUpstream(config, 'tmforum.usage').baseUrl).toBe(
            'https://tm-forum-api-svc:8080/tmf-api/usageManagement/v4'
        );
        expect(resolveUpstream(config, 'tmforum.customer').timeoutMs).toBe(20000);
    });

    it('omits the port when none is set at any level', () => {
        const config = upstreams({ BAE_UPSTREAMS__CHARGING__HOST: 'charging', BAE_UPSTREAMS__CHARGING__SCHEME: 'https' });
        expect(resolveUpstream(config, 'charging').baseUrl).toBe('https://charging');
    });

    it('applies the path of a standalone upstream', () => {
        const config = upstreams({ BAE_UPSTREAMS__REVENUE__HOST: 'revenue', BAE_UPSTREAMS__REVENUE__PORT: '8080' });
        expect(resolveUpstream(config, 'revenue').baseUrl).toBe('http://revenue:8080/revenue');
    });

    it('fails clearly, naming what to set, when no host is configured', () => {
        const config = upstreams({});
        expect(() => resolveUpstream(config, 'tmforum.catalog')).toThrow(
            'set upstreams.tmforum.host or upstreams.tmforum.apis.catalog.host'
        );
        expect(() => resolveUpstream(config, 'charging')).toThrow('set upstreams.charging.host');
    });

    it('does not know names outside the configuration', () => {
        const config = upstreams({});
        expect(() => resolveUpstream(config, 'tmforum.unknown')).toThrow('Unknown upstream');
        expect(() => resolveUpstream(config, 'nope')).toThrow('Unknown upstream');
        expect(() => resolveUpstream(config, 'timeoutMs')).toThrow('Unknown upstream');
    });
});
