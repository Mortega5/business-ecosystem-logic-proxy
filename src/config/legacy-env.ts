import { setPath, type PlainObject } from './plain-object';

export interface LegacyVariable {
    variable: string;
    key: string;
}

type Built = string | Record<string, string> | undefined;

// A rule sets one key, or several keys under its own when it returns an object
interface LegacyRule {
    key: string;
    variables: string[];
    build: (env: NodeJS.ProcessEnv) => Built;
}

const present = (value: string | undefined): value is string => value !== undefined && value !== '';

// Same defaults and rules as config.js and server.js: credentials only when there is both a user and a password
const buildMongoUri = (env: NodeJS.ProcessEnv): string | undefined => {
    const { BAE_LP_MONGO_SERVER: server, BAE_LP_MONGO_PORT: port, BAE_LP_MONGO_DB: db } = env;
    const { BAE_LP_MONGO_USER: user, BAE_LP_MONGO_PASS: password } = env;
    if (![server, port, db, user, password].some(present)) {
        return undefined;
    }
    const credentials =
        present(user) && present(password) ? `${encodeURIComponent(user)}:${encodeURIComponent(password)}@` : '';
    return `mongodb://${credentials}${present(server) ? server : 'mongo'}:${present(port) ? port : '27017'}/${present(db) ? db : 'belp'}`;
};

// With HTTPS the legacy application listens on its own port, which is 443 unless BAE_LP_HTTPS_PORT says otherwise
const buildPort = (env: NodeJS.ProcessEnv): string | undefined =>
    env.BAE_LP_HTTPS_ENABLED === 'true' ? (present(env.BAE_LP_HTTPS_PORT) ? env.BAE_LP_HTTPS_PORT : '443') : env.BAE_LP_PORT;

const SWITCHES: [string, string][] = [
    ['http.cors.exposeRedirect', 'BAE_LP_CORS_EXPOSE_REDIRECT'],
    ['auth.propagateToken', 'BAE_LP_PROPAGATE_TOKEN'],
    ['auth.allowLocalEori', 'BAE_LP_ALLOW_LOCAL_EORI'],
    ['purchase.enabled', 'BAE_LP_PURCHASE_ENABLED'],
    ['dataSpace.enabled', 'BAE_LP_DATASPACE_ENABLED'],
    ['catalogManagement.enabled', 'BAE_LP_CATALOG_MANAGEMENT_ENABLED'],
    ['dsp.enabled', 'BAE_LP_DSP_ENABLED'],
    ['quotes.enabled', 'BAE_LP_QUOTE_ENABLED'],
    ['tendering.enabled', 'BAE_LP_TENDERING_ENABLED'],
    ['launchValidation.enabled', 'BAE_LP_LAUNCH_VALIDATION_ENABLED'],
    ['tendering.devButtonsOpenClose', 'BAE_LP_TENDER_DEV_BUTTON_ENABLED']
];

const VALUES: [string, string][] = [
    ['auth.roles.admin', 'BAE_LP_OAUTH2_ADMIN_ROLE'],
    ['auth.roles.seller', 'BAE_LP_OAUTH2_SELLER_ROLE'],
    ['auth.roles.customer', 'BAE_LP_OAUTH2_CUSTOMER_ROLE'],
    ['auth.roles.orgAdmin', 'BAE_LP_OAUTH2_ORG_ADMIN_ROLE'],
    ['purchase.paymentGateway', 'BAE_LP_PAYMENT_GATEWAY'],
    ['quotes.api', 'BAE_LP_QUOTE_API'],
    ['dsp.contractDefinitionSchema', 'BAE_LP_DSP_CONTRACT_DEFINITION_SCHEMA'],
    ['catalog.offeringSchema', 'BAE_LP_OFFERING_SCHEMA'],
    ['catalog.priceCompSchema', 'BAE_LP_PRICE_COMP_SCHEMA'],
    ['catalog.blueprintSchema', 'BAE_LP_BLUEPRINT_SCHEMA']
];

// Like config.js, anything other than "true" turns a switch off
const switchRules: LegacyRule[] = SWITCHES.map(([key, variable]) => ({
    key,
    variables: [variable],
    build: (env) => (present(env[variable]) ? String(env[variable] === 'true') : undefined)
}));

const valueRules: LegacyRule[] = VALUES.map(([key, variable]) => ({
    key,
    variables: [variable],
    build: (env) => env[variable]
}));

// The legacy application trims and lowercases the provider, and an empty one means none
const paymentProviderRule: LegacyRule = {
    key: 'purchase.paymentProvider',
    variables: ['BAE_LP_PAYMENT_PROVIDER'],
    build: (env) => (present(env.BAE_LP_PAYMENT_PROVIDER) ? env.BAE_LP_PAYMENT_PROVIDER.trim().toLowerCase() || 'none' : undefined)
};

const TMFORUM_ENDPOINTS: [string, string][] = [
    ['catalog', 'CATALOG'],
    ['resource', 'RESOURCE'],
    ['service', 'SERVICE'],
    ['ordering', 'ORDERING'],
    ['inventory', 'INVENTORY'],
    ['serviceInventory', 'SERVICE_INVENTORY'],
    ['resourceInventory', 'RESOURCE_INVENTORY'],
    ['party', 'PARTY'],
    // The legacy names are crossed: BILLING configured the account endpoint and CUSTOMER_BILL the billing one
    ['account', 'BILLING'],
    ['customer', 'CUSTOMER'],
    ['customerBill', 'CUSTOMER_BILL'],
    ['usage', 'USAGE'],
    ['document', 'DOCUMENT'],
    ['invoicing', 'INVOICING'],
    ['software', 'SOFTWARE'],
    ['quote', 'QUOTE']
];

const STANDALONE_ENDPOINTS: [string, string][] = [
    ['charging', 'CHARGING'],
    ['rss', 'RSS'],
    ['revenue', 'REVENUE'],
    ['search', 'SEARCH']
];

// What the legacy application did not get from its variables it took from placeholder defaults; here it comes from
// the group. The path is the exception: it is the default path the legacy application had for that endpoint, which
// is empty for all but two, unless PATH says otherwise.
const LEGACY_DEFAULT_PATHS: Record<string, string> = { REVENUE: '/revenue', INVOICING: '/invoicing' };

const buildEndpoint =
    (legacyName: string) =>
    (env: NodeJS.ProcessEnv): Built => {
        const variable = (suffix: string): string | undefined => {
            const value = env[`BAE_LP_ENDPOINT_${legacyName}_${suffix}`];
            return present(value) ? value : undefined;
        };
        const [host, port, secured, path] = [variable('HOST'), variable('PORT'), variable('SECURED'), variable('PATH')];
        if (host === undefined && port === undefined && secured === undefined && path === undefined) {
            return undefined;
        }
        return {
            path: path ?? LEGACY_DEFAULT_PATHS[legacyName] ?? '',
            ...(host === undefined ? {} : { host }),
            ...(port === undefined ? {} : { port }),
            ...(secured === undefined ? {} : { scheme: secured === 'true' ? 'https' : 'http' })
        };
    };

const endpointRules: LegacyRule[] = [
    ...TMFORUM_ENDPOINTS.map(([api, legacyName]) => ({
        key: `upstreams.tmforum.apis.${api}`,
        variables: ['HOST', 'PORT', 'PATH', 'SECURED'].map((suffix) => `BAE_LP_ENDPOINT_${legacyName}_${suffix}`),
        build: buildEndpoint(legacyName)
    })),
    ...STANDALONE_ENDPOINTS.map(([name, legacyName]) => ({
        key: `upstreams.${name}`,
        variables: ['HOST', 'PORT', 'PATH', 'SECURED'].map((suffix) => `BAE_LP_ENDPOINT_${legacyName}_${suffix}`),
        build: buildEndpoint(legacyName)
    }))
];

const RULES: LegacyRule[] = [
    { key: 'app.port', variables: ['BAE_LP_PORT', 'BAE_LP_HTTPS_PORT'], build: buildPort },
    {
        key: 'app.https.enabled',
        variables: ['BAE_LP_HTTPS_ENABLED'],
        build: (env) => (env.BAE_LP_HTTPS_ENABLED === 'true' ? 'true' : undefined)
    },
    { key: 'app.https.certFile', variables: ['BAE_LP_HTTPS_CERT'], build: (env) => env.BAE_LP_HTTPS_CERT },
    { key: 'app.https.keyFile', variables: ['BAE_LP_HTTPS_KEY'], build: (env) => env.BAE_LP_HTTPS_KEY },
    { key: 'app.https.caFile', variables: ['BAE_LP_HTTPS_CA'], build: (env) => env.BAE_LP_HTTPS_CA },
    {
        key: 'mongo.uri',
        variables: ['BAE_LP_MONGO_SERVER', 'BAE_LP_MONGO_PORT', 'BAE_LP_MONGO_DB', 'BAE_LP_MONGO_USER', 'BAE_LP_MONGO_PASS'],
        build: buildMongoUri
    },
    paymentProviderRule,
    ...switchRules,
    ...valueRules,
    ...endpointRules
];

/** BAE_APP__SHUTDOWN_TIMEOUT_MS for app.shutdownTimeoutMs */
export const envNameFor = (key: string): string =>
    `BAE_${key
        .split('.')
        .map((segment) => segment.replace(/([A-Z])/g, '_$1').toUpperCase())
        .join('__')}`;

/** Translates the variables of the legacy application into the keys of the new configuration. */
export const legacyEnvToObject = (env: NodeJS.ProcessEnv): { values: PlainObject; used: LegacyVariable[] } => {
    const values: PlainObject = {};
    const used: LegacyVariable[] = [];
    for (const rule of RULES) {
        const built = rule.build(env);
        if (built === undefined || built === '') {
            continue;
        }
        if (typeof built === 'string') {
            setPath(values, rule.key.split('.'), built);
        } else {
            for (const [name, value] of Object.entries(built)) {
                setPath(values, [...rule.key.split('.'), name], value);
            }
        }
        for (const variable of rule.variables) {
            if (present(env[variable])) {
                used.push({ variable, key: rule.key });
            }
        }
    }
    return { values, used };
};
