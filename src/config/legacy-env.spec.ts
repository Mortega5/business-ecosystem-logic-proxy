import { describe, expect, it } from 'vitest';
import { envNameFor, legacyEnvToObject } from './legacy-env';

describe('legacyEnvToObject', () => {
    it('maps the port of the legacy application', () => {
        expect(legacyEnvToObject({ BAE_LP_PORT: '9000' })).toEqual({
            values: { app: { port: '9000' } },
            used: [{ variable: 'BAE_LP_PORT', key: 'app.port' }]
        });
    });

    it('maps the HTTPS variables, listening on the HTTPS port (443 by default) while it is enabled', () => {
        const env = {
            BAE_LP_PORT: '8004',
            BAE_LP_HTTPS_ENABLED: 'true',
            BAE_LP_HTTPS_CERT: '/tls/cert.pem',
            BAE_LP_HTTPS_KEY: '/tls/key.pem',
            BAE_LP_HTTPS_CA: '/tls/ca.pem'
        };

        expect(legacyEnvToObject(env).values).toEqual({
            app: { port: '443', https: { enabled: 'true', certFile: '/tls/cert.pem', keyFile: '/tls/key.pem', caFile: '/tls/ca.pem' } }
        });
        expect(legacyEnvToObject({ ...env, BAE_LP_HTTPS_PORT: '8443' }).values).toMatchObject({ app: { port: '8443' } });
    });

    it('keeps the plain port while HTTPS is not enabled, whatever else is set', () => {
        expect(legacyEnvToObject({ BAE_LP_PORT: '8004', BAE_LP_HTTPS_PORT: '8443', BAE_LP_HTTPS_ENABLED: 'false' }).values).toEqual({
            app: { port: '8004' }
        });
    });

    it('builds the MongoDB uri from its parts', () => {
        const { values, used } = legacyEnvToObject({
            BAE_LP_MONGO_SERVER: 'db.internal',
            BAE_LP_MONGO_PORT: '27018',
            BAE_LP_MONGO_DB: 'bae',
            BAE_LP_MONGO_USER: 'proxy',
            BAE_LP_MONGO_PASS: 'secret'
        });

        expect(values).toEqual({ mongo: { uri: 'mongodb://proxy:secret@db.internal:27018/bae' } });
        expect(used.map((u) => u.variable)).toEqual([
            'BAE_LP_MONGO_SERVER',
            'BAE_LP_MONGO_PORT',
            'BAE_LP_MONGO_DB',
            'BAE_LP_MONGO_USER',
            'BAE_LP_MONGO_PASS'
        ]);
    });

    it('fills the missing parts with the defaults of the legacy application', () => {
        expect(legacyEnvToObject({ BAE_LP_MONGO_SERVER: 'db.internal' }).values).toEqual({
            mongo: { uri: 'mongodb://db.internal:27017/belp' }
        });
        expect(legacyEnvToObject({ BAE_LP_MONGO_DB: 'other' }).values).toEqual({
            mongo: { uri: 'mongodb://mongo:27017/other' }
        });
    });

    it('uses credentials only when there is both a user and a password', () => {
        expect(legacyEnvToObject({ BAE_LP_MONGO_USER: 'proxy' }).values).toEqual({
            mongo: { uri: 'mongodb://mongo:27017/belp' }
        });
        expect(legacyEnvToObject({ BAE_LP_MONGO_PASS: 'secret' }).values).toEqual({
            mongo: { uri: 'mongodb://mongo:27017/belp' }
        });
    });

    it('escapes credentials that would break the uri', () => {
        const { values } = legacyEnvToObject({ BAE_LP_MONGO_USER: 'proxy', BAE_LP_MONGO_PASS: 'p@ss/w:rd' });

        expect(values).toEqual({ mongo: { uri: 'mongodb://proxy:p%40ss%2Fw%3Ard@mongo:27017/belp' } });
    });

    it('reports only the variables that are set and ignores empty ones', () => {
        expect(legacyEnvToObject({ BAE_LP_PORT: '', BAE_LP_MONGO_SERVER: '' })).toEqual({ values: {}, used: [] });
        expect(legacyEnvToObject({ PATH: '/bin', BAE_APP__PORT: '9000', BAE_LP_SOMETHING_THAT_IS_NOT_ONE: 'x' })).toEqual({ values: {}, used: [] });
    });
});

describe('envNameFor', () => {
    it.each([
        ['app.port', 'BAE_APP__PORT'],
        ['mongo.uri', 'BAE_MONGO__URI'],
        ['app.shutdownTimeoutMs', 'BAE_APP__SHUTDOWN_TIMEOUT_MS']
    ])('names the variable for %s', (key, expected) => {
        expect(envNameFor(key)).toBe(expected);
    });
});

describe('feature variables', () => {
    it('translates switches into their feature and turns anything but "true" into false', () => {
        const { values, used } = legacyEnvToObject({
            BAE_LP_PURCHASE_ENABLED: 'false',
            BAE_LP_DSP_ENABLED: 'true',
            BAE_LP_QUOTE_ENABLED: 'maybe',
            BAE_LP_TENDER_DEV_BUTTON_ENABLED: 'true'
        });
        expect(values).toEqual({
            purchase: { enabled: 'false' },
            dsp: { enabled: 'true' },
            quotes: { enabled: 'false' },
            tendering: { devButtonsOpenClose: 'true' }
        });
        expect(used.map((entry) => entry.variable).sort()).toEqual([
            'BAE_LP_DSP_ENABLED',
            'BAE_LP_PURCHASE_ENABLED',
            'BAE_LP_QUOTE_ENABLED',
            'BAE_LP_TENDER_DEV_BUTTON_ENABLED'
        ]);
    });

    it('moves each setting next to its feature', () => {
        const { values } = legacyEnvToObject({
            BAE_LP_PAYMENT_GATEWAY: 'https://pay.example.org',
            BAE_LP_PAYMENT_PROVIDER: ' DPAS ',
            BAE_LP_QUOTE_API: '/quotes',
            BAE_LP_OFFERING_SCHEMA: 'https://schemas.example.org/offering.json'
        });
        expect(values).toEqual({
            purchase: { paymentGateway: 'https://pay.example.org', paymentProvider: 'dpas' },
            quotes: { api: '/quotes' },
            catalog: { offeringSchema: 'https://schemas.example.org/offering.json' }
        });
    });

    it('moves the settings of the default catalog and of the related party schema into the catalog section', () => {
        const { values } = legacyEnvToObject({
            BAE_LP_DEFAULT_CATALOG_ID: 'urn:ngsi-ld:catalog:1',
            BAE_LP_DEFAULT_CATALOG_NAME: 'platform',
            BAE_LP_PARTY_LOCATION: 'https://schemas.example.org/party.json'
        });
        expect(values).toEqual({
            catalog: { defaultCatalogId: 'urn:ngsi-ld:catalog:1', defaultCatalogName: 'platform', partyLocation: 'https://schemas.example.org/party.json' }
        });
    });

    it('reads a blank payment provider as none', () => {
        expect(legacyEnvToObject({ BAE_LP_PAYMENT_PROVIDER: '  ' }).values).toEqual({ purchase: { paymentProvider: 'none' } });
    });
});

describe('legacy endpoint variables', () => {
    const endpoint = (name: string, vars: Record<string, string>): NodeJS.ProcessEnv =>
        Object.fromEntries(Object.entries(vars).map(([suffix, value]) => [`BAE_LP_ENDPOINT_${name}_${suffix}`, value]));
    const apis = (values: unknown) =>
        (values as { upstreams: { tmforum: { apis: Record<string, Record<string, unknown>> } } }).upstreams.tmforum.apis;

    it('translates the host, port and path of an API', () => {
        const { values, used } = legacyEnvToObject(
            endpoint('CATALOG', { HOST: 'tm-forum-api-svc', PORT: '8080', PATH: '/tmf-api/productCatalogManagement/v4' })
        );
        expect(apis(values)).toEqual({
            catalog: { host: 'tm-forum-api-svc', port: '8080', path: '/tmf-api/productCatalogManagement/v4' }
        });
        expect(used.map((entry) => entry.variable)).toEqual([
            'BAE_LP_ENDPOINT_CATALOG_HOST',
            'BAE_LP_ENDPOINT_CATALOG_PORT',
            'BAE_LP_ENDPOINT_CATALOG_PATH'
        ]);
    });

    it('turns SECURED into the scheme and gives the path of the legacy endpoint when there is no PATH', () => {
        expect(apis(legacyEnvToObject(endpoint('QUOTE', { HOST: 'quote', PORT: '8443', SECURED: 'true' })).values)).toEqual({
            quote: { host: 'quote', port: '8443', scheme: 'https', path: '' }
        });
        expect(apis(legacyEnvToObject(endpoint('QUOTE', { SECURED: 'no' })).values).quote).toEqual({ scheme: 'http', path: '' });
    });

    it('translates a lone HOST or PORT, which then inherit the rest from the group', () => {
        expect(apis(legacyEnvToObject(endpoint('PARTY', { HOST: 'party' })).values).party).toEqual({ host: 'party', path: '' });
        expect(apis(legacyEnvToObject(endpoint('PARTY', { PORT: '9090' })).values).party).toEqual({ port: '9090', path: '' });
    });

    it('keeps the legacy crossed names: BILLING is the account API and CUSTOMER_BILL the customer bill one', () => {
        const { values } = legacyEnvToObject({
            ...endpoint('BILLING', { PATH: '/tmf-api/accountManagement/v4' }),
            ...endpoint('CUSTOMER_BILL', { PATH: '/tmf-api/customerBillManagement/v4' })
        });
        expect(Object.keys(apis(values)).sort()).toEqual(['account', 'customerBill']);
        expect(apis(values).account?.path).toBe('/tmf-api/accountManagement/v4');
    });

    it('keeps the default path the legacy application had for revenue and invoicing', () => {
        expect(legacyEnvToObject(endpoint('REVENUE', { HOST: 'revenue', PORT: '8080' })).values).toEqual({
            upstreams: { revenue: { host: 'revenue', port: '8080', path: '/revenue' } }
        });
        expect(apis(legacyEnvToObject(endpoint('INVOICING', { HOST: 'tmf', PORT: '8080' })).values).invoicing?.path).toBe('/invoicing');
        expect(legacyEnvToObject(endpoint('REVENUE', { HOST: 'revenue', PORT: '8080', PATH: '/other' })).values).toEqual({
            upstreams: { revenue: { host: 'revenue', port: '8080', path: '/other' } }
        });
    });

    it('turns the address of the contact form notification into an upstream', () => {
        expect(legacyEnvToObject({ BAE_LP_CONTACT_US_NOTIFICATION_URL: 'https://mail.example.org:8443/notify/contact' }).values).toEqual({
            upstreams: { contactUs: { host: 'mail.example.org', port: '8443', scheme: 'https', path: '/notify/contact' } }
        });
        expect(legacyEnvToObject({ BAE_LP_CONTACT_US_NOTIFICATION_URL: 'http://mail/' }).values).toEqual({
            upstreams: { contactUs: { host: 'mail', scheme: 'http', path: '' } }
        });
        expect(legacyEnvToObject({}).values).toEqual({});
    });

    it('turns the address of the billing engine into an upstream', () => {
        expect(legacyEnvToObject({ BAE_LP_BILLING_ENGINE_URL: 'http://engine:8080/billing/previewPrice' }).values).toEqual({
            upstreams: { billingEngine: { host: 'engine', port: '8080', scheme: 'http', path: '/billing/previewPrice' } }
        });
    });

    it('configures the standalone upstreams', () => {
        const { values } = legacyEnvToObject(endpoint('CHARGING', { HOST: 'charging.svc.cluster.local', PORT: '8006' }));
        expect(values).toEqual({ upstreams: { charging: { host: 'charging.svc.cluster.local', port: '8006', path: '' } } });
    });
});
