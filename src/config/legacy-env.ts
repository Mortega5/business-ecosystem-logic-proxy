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
    }
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
