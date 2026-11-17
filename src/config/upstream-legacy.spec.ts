import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadStaticConfig } from './config.loader';
import { resolveUpstream } from './upstream-resolution';

const DEFAULTS_PATH = join(__dirname, '../../config/default.yaml');

const TMF = 'tm-forum-api-svc';
const PATHS: Record<string, string> = {
    CATALOG: '/tmf-api/productCatalogManagement/v4',
    INVENTORY: '/tmf-api/productInventory/v4',
    SERVICE_INVENTORY: '/tmf-api/serviceInventory/v4',
    RESOURCE_INVENTORY: '/tmf-api/resourceInventoryManagement/v4',
    ORDERING: '/tmf-api/productOrderingManagement/v4',
    BILLING: '/tmf-api/accountManagement/v4',
    RESOURCE: '/tmf-api/resourceCatalog/v4',
    SERVICE: '/tmf-api/serviceCatalogManagement/v4',
    USAGE: '/tmf-api/usageManagement/v4',
    PARTY: '/tmf-api/party/v4',
    CUSTOMER: '/tmf-api/customerManagement/v4',
    CUSTOMER_BILL: '/tmf-api/customerBillManagement/v4',
    SOFTWARE: '/tmf-api/softwareCompute/v4'
};

// The endpoint variables of a real deployment: every TMForum API on one service, each with its own path
const deployment: NodeJS.ProcessEnv = {
    BAE_LP_ENDPOINT_CHARGING_HOST: 'provider-biz-ecosystem-charging-backend.provider.svc.cluster.local',
    BAE_LP_ENDPOINT_CHARGING_PORT: '8006'
};
for (const [name, path] of Object.entries(PATHS)) {
    deployment[`BAE_LP_ENDPOINT_${name}_HOST`] = TMF;
    deployment[`BAE_LP_ENDPOINT_${name}_PORT`] = '8080';
    deployment[`BAE_LP_ENDPOINT_${name}_PATH`] = path;
}

describe('a deployment configured with the legacy endpoint variables', () => {
    const { upstreams } = loadStaticConfig({ defaultsPath: DEFAULTS_PATH, env: deployment });

    it('reaches every TMForum API at the same URL as before', () => {
        expect(resolveUpstream(upstreams, 'tmforum.catalog').baseUrl).toBe(`http://${TMF}:8080${PATHS.CATALOG}`);
        expect(resolveUpstream(upstreams, 'tmforum.account').baseUrl).toBe(`http://${TMF}:8080${PATHS.BILLING}`);
        expect(resolveUpstream(upstreams, 'tmforum.customerBill').baseUrl).toBe(`http://${TMF}:8080${PATHS.CUSTOMER_BILL}`);
        expect(resolveUpstream(upstreams, 'tmforum.software').baseUrl).toBe(`http://${TMF}:8080${PATHS.SOFTWARE}`);
    });

    it('reaches the charging backend without a path', () => {
        expect(resolveUpstream(upstreams, 'charging').baseUrl).toBe(
            'http://provider-biz-ecosystem-charging-backend.provider.svc.cluster.local:8006'
        );
    });

    it('does not guess a host for what the deployment leaves out', () => {
        expect(() => resolveUpstream(upstreams, 'tmforum.quote')).toThrow('has no host');
        expect(() => resolveUpstream(upstreams, 'rss')).toThrow('has no host');
    });

    it('takes the host or the port a legacy variable leaves out from the group default', () => {
        const partial = loadStaticConfig({
            defaultsPath: DEFAULTS_PATH,
            env: {
                BAE_UPSTREAMS__TMFORUM__HOST: TMF,
                BAE_UPSTREAMS__TMFORUM__PORT: '8080',
                BAE_LP_ENDPOINT_CATALOG_PORT: '9090',
                BAE_LP_ENDPOINT_PARTY_HOST: 'party'
            }
        }).upstreams;
        expect(resolveUpstream(partial, 'tmforum.catalog').baseUrl).toBe(`http://${TMF}:9090`);
        expect(resolveUpstream(partial, 'tmforum.party').baseUrl).toBe('http://party:8080');
    });

    it('lets the new variables win over the legacy ones', () => {
        const overridden = loadStaticConfig({
            defaultsPath: DEFAULTS_PATH,
            env: { ...deployment, BAE_UPSTREAMS__TMFORUM__APIS__CATALOG__HOST: 'other', BAE_UPSTREAMS__TMFORUM__APIS__CATALOG__PORT: '9000' }
        }).upstreams;
        expect(resolveUpstream(overridden, 'tmforum.catalog').baseUrl).toBe(`http://other:9000${PATHS.CATALOG}`);
    });
});
