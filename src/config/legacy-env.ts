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
    ['auth.idp.oidcEnabled', 'BAE_LP_OIDC_ENABLED'],
    ['purchase.enabled', 'BAE_LP_PURCHASE_ENABLED'],
    ['analytics.enabled', 'BAE_LP_ANALYTICS_ENABLED'],
    ['datasets.enabled', 'BAE_LP_DATASETS_ENABLED'],
    ['apiAccess.enabled', 'BAE_LP_API_ACCESS_ENABLED'],
    ['fileService.enabled', 'BAE_LP_FILE_SERVICE_ENABLED'],
    ['dataSpace.enabled', 'BAE_LP_DATASPACE_ENABLED'],
    ['catalogManagement.enabled', 'BAE_LP_CATALOG_MANAGEMENT_ENABLED'],
    ['dsp.enabled', 'BAE_LP_DSP_ENABLED'],
    ['quotes.enabled', 'BAE_LP_QUOTE_ENABLED'],
    ['tendering.enabled', 'BAE_LP_TENDERING_ENABLED'],
    ['party.editEnabled', 'BAE_LP_EDIT_PARTY'],
    ['launchValidation.enabled', 'BAE_LP_LAUNCH_VALIDATION_ENABLED'],
    ['launchValidation.allowUntrustedCertificates', 'BAE_LP_LAUNCH_VALIDATION_ALLOW_UNTRUSTED_CERTIFICATES'],
    ['tendering.devButtonsOpenClose', 'BAE_LP_TENDER_DEV_BUTTON_ENABLED'],
    ['auth.vc.enabled', 'BAE_LP_SIOP_ENABLED'],
    ['auth.vc.isRedirection', 'BAE_LP_SIOP_IS_REDIRECTION']
];

const VALUES: [string, string][] = [
    ['auth.idp.provider', 'BAE_LP_OAUTH2_PROVIDER'],
    ['auth.idp.server', 'BAE_LP_OAUTH2_SERVER'],
    ['auth.idp.clientId', 'BAE_LP_OAUTH2_CLIENT_ID'],
    ['auth.idp.clientSecret', 'BAE_LP_OAUTH2_CLIENT_SECRET'],
    ['auth.idp.callbackUrl', 'BAE_LP_OAUTH2_CALLBACK'],
    ['auth.idp.realm', 'BAE_LP_OIDC_REALM'],
    ['auth.idp.discoveryUrl', 'BAE_LP_OIDC_DISCOVERY_URI'],
    ['auth.idp.tokenAuthMethod', 'BAE_LP_OIDC_TOKEN_AUTH_METHOD'],
    ['auth.idp.scopes', 'BAE_LP_OIDC_SCOPES'],
    ['auth.externalPortal', 'BAE_LP_EXTERNAL_PORTAL'],
    ['auth.externalLogin.enabled', 'BAE_LP_EXT_LOGIN'],
    ['auth.externalLogin.eori', 'BAE_EORI'],
    ['auth.externalLogin.tokenKey', 'BAE_TOKEN_KEY'],
    ['auth.externalLogin.tokenCrt', 'BAE_TOKEN_CRT'],
    ['auth.idp.tokenKey', 'BAE_LP_OIDC_TOKEN_KEY'],
    ['auth.idp.tokenCrt', 'BAE_LP_OIDC_TOKEN_CRT'],
    ['auth.idp.oidcKey', 'BAE_LP_OIDC_KEY'],
    ['auth.idp.defaultRole', 'BAE_LP_OAUTH2_DEFAULT_ROLE'],
    ['auth.roles.admin', 'BAE_LP_OAUTH2_ADMIN_ROLE'],
    ['auth.roles.seller', 'BAE_LP_OAUTH2_SELLER_ROLE'],
    ['auth.roles.customer', 'BAE_LP_OAUTH2_CUSTOMER_ROLE'],
    ['auth.roles.orgAdmin', 'BAE_LP_OAUTH2_ORG_ADMIN_ROLE'],
    ['purchase.paymentGateway', 'BAE_LP_PAYMENT_GATEWAY'],
    ['portal.chatUrl', 'BAE_LP_CHAT_URL'],
    ['portal.knowledgeBaseUrl', 'BAE_LP_KNOWLEDGE_BASE_URL'],
    ['portal.ticketingUrl', 'BAE_LP_TICKETING_URL'],
    ['portal.matomoId', 'BAE_LP_MATOMO_ID'],
    ['portal.matomoUrl', 'BAE_LP_MATOMO_URL'],
    ['portal.googleTagManagerId', 'BAE_LP_GOOGLE_TAG_MANAGER_ID'],
    ['portal.theme', 'BAE_LP_THEME'],
    ['quotes.api', 'BAE_LP_QUOTE_API'],
    ['dsp.contractDefinitionSchema', 'BAE_LP_DSP_CONTRACT_DEFINITION_SCHEMA'],
    ['catalog.offeringSchema', 'BAE_LP_OFFERING_SCHEMA'],
    ['catalog.partyLocation', 'BAE_LP_PARTY_LOCATION'],
    ['catalog.defaultCatalogId', 'BAE_LP_DEFAULT_CATALOG_ID'],
    ['catalog.defaultCatalogName', 'BAE_LP_DEFAULT_CATALOG_NAME'],
    ['catalog.priceCompSchema', 'BAE_LP_PRICE_COMP_SCHEMA'],
    ['catalog.blueprintSchema', 'BAE_LP_BLUEPRINT_SCHEMA'],
    ['fileService.url', 'BAE_LP_FILE_SERVICE_URL'],
    ['fileService.token', 'BAE_LP_FILE_SERVICE_TOKEN'],
    ['fileService.timeoutMs', 'BAE_LP_FILE_SERVICE_TIMEOUT'],
    ['fileService.maxSizeMb', 'BAE_LP_FILE_SERVICE_MAX_SIZE_MB'],
    ['fileService.acceptedTypes', 'BAE_LP_FILE_SERVICE_ACCEPTED_TYPES'],
    ['compliance.serverUrl', 'BAE_LP_COMPLIANCE_SERVER_URL'],
    ['compliance.certifierRole', 'BAE_LP_OAUTH2_ORG_CERTIFIER_ROLE'],
    ['analytics.url', 'BAE_LP_ANALYTICS_URL'],
    ['analytics.guestTokenPath', 'BAE_LP_ANALYTICS_SUPERSET_GUEST_TOKEN_PATH'],
    ['analytics.dashboards.businessInsightsNonLear', 'BAE_LP_ANALYTICS_DASHBOARD_BUSINESS_INSIGHTS_NON_LEAR'],
    ['analytics.dashboards.businessInsightsLear', 'BAE_LP_ANALYTICS_DASHBOARD_BUSINESS_INSIGHTS_LEAR'],
    ['analytics.dashboards.usageMonitor', 'BAE_LP_ANALYTICS_DASHBOARD_USAGE_MONITOR'],
    ['auth.vc.clientId', 'BAE_LP_SIOP_CLIENT_ID'],
    ['auth.vc.privateKey', 'BAE_LP_SIOP_PRIVATE_KEY'],
    ['auth.vc.privateKeyFile', 'BAE_LP_SIOP_PRIVATE_KEY_PEM'],
    ['auth.vc.callbackUrl', 'BAE_LP_SIOP_CALLBACK_PATH'],
    ['auth.vc.requestUri', 'BAE_LP_SIOP_REQUEST_URI'],
    ['auth.vc.verifierHost', 'BAE_LP_SIOP_VERIFIER_HOST'],
    ['auth.vc.verifierQrCodePath', 'BAE_LP_SIOP_VERIFIER_QRCODE_PATH'],
    ['auth.vc.verifierTokenPath', 'BAE_LP_SIOP_VERIFIER_TOKEN_PATH'],
    ['auth.vc.verifierJwksPath', 'BAE_LP_SIOP_VERIFIER_JWKS_PATH'],
    // The variable is called SIO and not SIOP, as v11 had it
    ['auth.vc.signAlgorithm', 'BAE_LP_SIO_SIGN_ALGORITHM'],
    ['auth.vc.certifierRole', 'BAE_LP_OAUTH2_ORG_CERTIFIER_ROLE']
];

// Anything other than "true" turns a switch off
const switchRules: LegacyRule[] = SWITCHES.map(([key, variable]) => ({
    key,
    variables: [variable],
    build: (env) => (present(env[variable]) ? String(env[variable] === 'true') : undefined)
}));

// These start on: only "false" turns them off
const OFF_ONLY_BY_FALSE: [string, string][] = [
    ['blueprints.enabled', 'BAE_LP_BLUEPRINTS_ENABLED'],
    ['software.enabled', 'BAE_LP_SOFTWARE_ENABLED']
];
const offOnlyByFalseRules: LegacyRule[] = OFF_ONLY_BY_FALSE.map(([key, variable]) => ({
    key,
    variables: [variable],
    build: (env) => (present(env[variable]) ? String(env[variable] !== 'false') : undefined)
}));

const valueRules: LegacyRule[] = VALUES.map(([key, variable]) => ({
    key,
    variables: [variable],
    build: (env) => env[variable]
}));

// The provider is trimmed and lowercased, and an empty one means none
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
    // BILLING is the account API and CUSTOMER_BILL the customer bill one
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
    ['revenue', 'REVENUE'],
    ['search', 'SEARCH']
];

// TO REMOVE: what the portal reads from `GET /config` that is not the core's, and that v11 reads from variables of its own. They are taken
// into `portal.extra` so that a deployment of v11 goes on working; the day they are set in `portal.extra` (or by a module of their own),
// delete this block, `legacyPortalDefaults`, its use in config.loader.ts, its tests in config.loader.spec.ts and the rows of
// docs/kubernetes.md that say TO REMOVE.
const PORTAL_EXTRA_VARIABLES: [key: string, variable: string][] = [
    ['portal.extra.domeTrust', 'BAE_LP_DOME_TRUST'],
    ['portal.extra.domeAbout', 'BAE_LP_DOME_ABOUT'],
    ['portal.extra.domeRegister', 'BAE_LP_DOME_REGISTER'],
    ['portal.extra.domeRegistrationForm', 'BAE_LP_DOME_REGISTRATION_FORM'],
    ['portal.extra.domeOnboardingGuidelines', 'BAE_LP_DOME_ONBOARDING_GUIDELINES'],
    ['portal.extra.domeGuidelines', 'BAE_LP_DOME_GUIDELINES'],
    ['portal.extra.domePublish', 'BAE_LP_DOME_PUBLISH'],
    ['portal.extra.learUrl', 'BAE_LP_LEAR_URL'],
    ['portal.extra.roles.certifier', 'BAE_LP_OAUTH2_ORG_CERTIFIER_ROLE']
];

// The lists of the login with credentials are separated by commas
const COMMA_LISTS: [string, string][] = [
    ['auth.vc.operators', 'BAE_LP_SIOP_OPERATORS'],
    ['auth.vc.certIssuers', 'BAE_LP_SIOP_CERT_ISSUERS']
];
const LIST_KEYS = new Set(COMMA_LISTS.map(([key]) => key));
const commaListRules: LegacyRule[] = COMMA_LISTS.map(([key, variable]) => ({
    key,
    variables: [variable],
    build: (env) =>
        present(env[variable])
            ? JSON.stringify(
                  env[variable]
                      .split(',')
                      .map((entry) => entry.trim())
                      .filter((entry) => entry !== '')
              )
            : undefined
}));

const portalExtraRules: LegacyRule[] = [
    ...PORTAL_EXTRA_VARIABLES.map(([key, variable]) => ({ key, variables: [variable], build: (env: NodeJS.ProcessEnv) => env[variable] })),
    // The register link of the customers is the register link when it has none of its own
    {
        key: 'portal.extra.domeRegisterCustomer',
        variables: ['BAE_LP_DOME_REGISTER_CUSTOMER', 'BAE_LP_DOME_REGISTER'],
        build: (env) => (present(env.BAE_LP_DOME_REGISTER_CUSTOMER) ? env.BAE_LP_DOME_REGISTER_CUSTOMER : env.BAE_LP_DOME_REGISTER)
    }
];

const DOME_REGISTER = 'https://dome-marketplace.github.io/onboarding/';

/** TO REMOVE: the addresses that v11 gave by default to the links of the portal, which apply when no variable, file or `portal.extra` sets them. */
export const legacyPortalDefaults = (): PlainObject => ({
    portal: {
        extra: {
            domeAbout: 'https://dome-marketplace.eu/about/',
            domeRegister: DOME_REGISTER,
            domeRegisterCustomer: DOME_REGISTER,
            domePublish: 'https://knowledgebase.dome-marketplace.org/shelves/company-onboarding-process'
        }
    }
});

// The host or the port that the variables leave out come from the group. The path is the one of the legacy endpoint,
// which is empty except for revenue and invoicing, unless PATH says otherwise.
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

// The legacy application notifies the contact form at one URL; here it is an upstream like the others
const contactUsRule: LegacyRule = {
    key: 'upstreams.contactUs',
    variables: ['BAE_LP_CONTACT_US_NOTIFICATION_URL'],
    build: (env) => {
        const value = env.BAE_LP_CONTACT_US_NOTIFICATION_URL;
        if (!present(value)) {
            return undefined;
        }
        const url = new URL(value);
        return {
            host: url.hostname,
            ...(url.port === '' ? {} : { port: url.port }),
            scheme: url.protocol === 'https:' ? 'https' : 'http',
            path: url.pathname === '/' ? '' : url.pathname
        };
    }
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
    // The legacy application searches when it has the address of the engine
    { key: 'search.enabled', variables: ['BAE_LP_SEARCH_URL'], build: (env) => (present(env.BAE_LP_SEARCH_URL) ? 'true' : undefined) },
    ...switchRules,
    ...offOnlyByFalseRules,
    ...valueRules,
    ...commaListRules,
    ...portalExtraRules,
    contactUsRule,
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
            setPath(values, rule.key.split('.'), LIST_KEYS.has(rule.key) ? (JSON.parse(built) as string[]) : built);
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
