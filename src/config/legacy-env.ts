import { setPath, type PlainObject } from './plain-object';

export interface LegacyVariable {
    variable: string;
    key: string;
}

interface LegacyRule {
    key: string;
    variables: string[];
    build: (env: NodeJS.ProcessEnv) => string | undefined;
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
    ...valueRules
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
        const value = rule.build(env);
        if (!present(value)) {
            continue;
        }
        setPath(values, rule.key.split('.'), value);
        for (const variable of rule.variables) {
            if (present(env[variable])) {
                used.push({ variable, key: rule.key });
            }
        }
    }
    return { values, used };
};
