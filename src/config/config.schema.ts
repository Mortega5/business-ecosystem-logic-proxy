import { z } from 'zod';
import { parseSize } from '../common/size';

// Environment variables always arrive as strings, and z.coerce.boolean() reads "false" as true
const booleanLike = z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .transform((value) => value === true || value === 'true');

// `*` or a serialized origin (scheme://host[:port], no path)
const strictOrigin = z.string().regex(/^https?:\/\/[^/\s?#*]+$/, 'must be an origin such as https://portal.example.org');
const origin = z.union([z.literal('*'), strictOrigin]);

const timeoutMs = z.coerce.number().int().positive();

const address = {
    host: z
        .string()
        .regex(/^(\[[0-9a-fA-F:.]+\]|[^\s/:@?#]+)$/, 'must be a host name or address, without scheme or port')
        .optional(),
    port: z.coerce.number().int().min(1).max(65535).optional(),
    scheme: z.enum(['http', 'https']).optional()
};

// An upstream, or one API of a group: whatever it leaves out it takes from its group
const upstreamEntry = z.strictObject({
    ...address,
    path: z.string().regex(/^(\/.*)?$/, 'must be empty or start with /').optional(),
    timeoutMs: timeoutMs.optional()
});

const tmforumApis = z.strictObject({
    catalog: upstreamEntry,
    resource: upstreamEntry,
    service: upstreamEntry,
    ordering: upstreamEntry,
    inventory: upstreamEntry,
    serviceInventory: upstreamEntry,
    resourceInventory: upstreamEntry,
    party: upstreamEntry,
    account: upstreamEntry,
    customer: upstreamEntry,
    customerBill: upstreamEntry,
    usage: upstreamEntry,
    document: upstreamEntry,
    invoicing: upstreamEntry,
    software: upstreamEntry,
    quote: upstreamEntry
});

const upstreamsSchema = z.strictObject({
    timeoutMs,
    tmforum: z.strictObject({
        ...address,
        timeoutMs: timeoutMs.optional(),
        apis: tmforumApis
    }),
    charging: upstreamEntry,
    revenue: upstreamEntry,
    search: upstreamEntry,
    // Where the contact form is notified, when it is not the charging backend
    contactUs: upstreamEntry.optional()
});

export const ConfigSchema = z.object({
    app: z
        .object({
            host: z.string().min(1).optional(),
            port: z.coerce.number().int().min(1).max(65535),
            shutdownTimeoutMs: z.coerce.number().int().positive(),
            shutdownDelayMs: z.coerce.number().int().min(0),
            https: z.object({
                enabled: booleanLike,
                keyFile: z.string().min(1).optional(),
                certFile: z.string().min(1).optional(),
                caFile: z.string().min(1).optional()
            })
        })
        .refine((app) => app.shutdownTimeoutMs > app.shutdownDelayMs, {
            path: ['shutdownTimeoutMs'],
            message: 'must be greater than app.shutdownDelayMs'
        })
        .superRefine((app, ctx) => {
            if (!app.https.enabled) {
                return;
            }
            for (const file of ['keyFile', 'certFile'] as const) {
                if (app.https[file] === undefined) {
                    ctx.addIssue({ code: 'custom', path: ['https', file], message: 'is required when app.https.enabled is true' });
                }
            }
        }),
    http: z.object({
        trustedProxies: z.array(z.string().min(1)),
        bodyLimit: z.string().min(1),
        uploadLimit: z.string().refine((value) => parseSize(value) !== undefined, 'must be a size such as 50mb'),
        cors: z.object({
            origins: z.array(origin),
            exposeRedirect: booleanLike
        })
    }),
    security: z.object({
        csp: z.object({ reportOnly: booleanLike }),
        hsts: z.object({
            enabled: booleanLike,
            maxAgeSeconds: z.coerce.number().int().positive(),
            includeSubDomains: booleanLike
        }),
        crossOriginResourcePolicy: z.enum(['same-origin', 'same-site', 'cross-origin']),
        csrf: z.object({
            enabled: booleanLike,
            trustedOrigins: z.array(strictOrigin)
        })
    }),
    logging: z.object({
        level: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']),
        format: z.enum(['json', 'pretty']),
        prettyOptions: z.record(z.string(), z.unknown())
    }),
    mongo: z.object({
        uri: z.string().min(1),
        maxPoolSize: z.coerce.number().int().positive(),
        serverSelectionTimeoutMs: z.coerce.number().int().positive(),
        heartbeatFrequencyMs: z.coerce.number().int().min(500),
        retryInitialDelayMs: z.coerce.number().int().positive(),
        retryMaxDelayMs: z.coerce.number().int().positive()
    }),
    auth: z.object({
        propagateToken: booleanLike,
        allowLocalEori: booleanLike,
        roles: z.object({
            admin: z.string().min(1),
            customer: z.string().min(1),
            seller: z.string().min(1),
            orgAdmin: z.string().min(1)
        }),
        // After a refresh, how long the token that was replaced still answers with the renewed profile: it is for the requests
        // that were already on their way with it, so it is short
        replacedTokenGraceMs: z.coerce.number().int().nonnegative(),
        // How long a profile is kept so that a user whose token has ended can still be refreshed. It is also how long a token that
        // was revoked at the identity provider keeps working here, since the provider is not asked while the profile is kept
        profileTtlMs: z.coerce.number().int().positive(),
        // A token with this many seconds left or fewer is refreshed
        refreshMarginSeconds: z.coerce.number().int().nonnegative(),
        // Lifetime given to a token whose identity provider does not say when it ends
        defaultTokenLifetimeSeconds: z.coerce.number().int().positive(),
        // How long a call to the identity provider (user info, refresh) may take
        idpTimeoutMs: z.coerce.number().int().positive(),
        // The main identity provider, the one called `local`. What each provider needs is checked when it is built, at start-up
        idp: z.object({
            provider: z.enum(['fiware', 'keycloak', 'github', 'i4trust', 'oidc-discover', 'aimarket']),
            server: z.string().min(1).optional(),
            clientId: z.string().min(1).optional(),
            clientSecret: z.string().min(1).optional(),
            callbackUrl: z.string().min(1).optional(),
            realm: z.string().min(1).optional(),
            // fiware and aimarket: the token is a JWT signed with the key (OIDC mode) or it is asked to the identity manager
            oidcEnabled: booleanLike,
            oidcKey: z.string().min(16).optional(),
            // Role of a user that arrives without roles
            defaultRole: z.string().min(1).optional()
        }),
        // Where the profile of each token is kept: in the process, or in MongoDB so that every instance shares it. The profile
        // holds refresh tokens, so in MongoDB it is sealed with the key, which has to be a random string of its own
        store: z
            .object({
                type: z.enum(['memory', 'mongo']),
                memoryMaxEntries: z.coerce.number().int().positive(),
                encryptionKey: z.string().min(32).optional()
            })
            .refine((store) => store.type !== 'mongo' || store.encryptionKey !== undefined, {
                path: ['encryptionKey'],
                message: 'is required when auth.store.type is mongo'
            })
    }),
    purchase: z
        .object({
            enabled: booleanLike,
            paymentProvider: z.enum(['dpas', 'paypal', 'stripe', 'none']),
            paymentGateway: z.url().optional()
        })
        .refine((purchase) => purchase.paymentProvider !== 'dpas' || purchase.paymentGateway !== undefined, {
            path: ['paymentGateway'],
            message: 'is required when purchase.paymentProvider is dpas'
        }),
    quotes: z.object({ enabled: booleanLike, api: z.string().min(1) }),
    tendering: z.object({ enabled: booleanLike, devButtonsOpenClose: booleanLike }),
    party: z.object({ editEnabled: booleanLike }),
    dsp: z
        .object({ enabled: booleanLike, contractDefinitionSchema: z.url().optional() })
        .refine((dsp) => !dsp.enabled || dsp.contractDefinitionSchema !== undefined, {
            path: ['contractDefinitionSchema'],
            message: 'is required when dsp.enabled is true'
        }),
    // With it on, an offering is launched only when its product has an image, its seller is an organisation with a country that is not
    // just initialised, and the product carries a compliance credential. The credential brings its own certificate and no trusted root is
    // set yet, so by default one that is signed by any certificate is taken, with a warning; with the flag off it is refused
    launchValidation: z.object({ enabled: booleanLike, allowUntrustedCertificates: booleanLike }),
    // With it on, the lists of offerings that ask for a keyword or a category go through the search engine of the marketplace, which pages
    // and sorts them and gives their ids; with it off the lists go to the catalog API as they are asked, and a keyword is not looked at
    search: z.object({ enabled: booleanLike }),
    dataSpace: z.object({ enabled: booleanLike }),
    catalogManagement: z.object({ enabled: booleanLike }),
    catalog: z.object({
        offeringSchema: z.url(),
        priceCompSchema: z.url(),
        blueprintSchema: z.url(),
        partyLocation: z.url(),
        // The default catalog lists the root categories the marketplace shows. When this id is set it is the one that is used (it has
        // to exist); otherwise the start-up finds the stored one, the one marked with the catalog type `default`, or makes one
        defaultCatalogId: z.string(),
        defaultCatalogName: z.string().min(1),
        // One category per kind of product the marketplace sells: they are made at start-up, belong to the default catalog, and cannot
        // be retired, renamed or moved. A catalog cannot be named as one of them
        // What the proxy makes sure of every time it starts: the default catalog, the system categories and the support package spec of
        // the software. It does nothing when it is off, and a thing that is not there is then not made; it retries while the TMForum is down
        bootstrap: z.object({
            enabled: booleanLike,
            retryDelayMs: z.coerce.number().int().positive(),
            // The ids of the records in which it keeps what it found. They are the ones v11 used: what was stored is lost if they change
            records: z.object({ defaultCatalog: z.string().min(1), supportPackageSpec: z.string().min(1) })
        }),
        systemCategories: z.array(z.object({ key: z.string().min(1), name: z.string().min(1), description: z.string() })).min(1)
    }),
    // What the proxy refuses to take or to read at once: each is a number of things, or of characters, and a bigger one costs more of the
    // service that has to hold it
    limits: z.object({
        orderItems: z.coerce.number().int().positive(),
        // The items that the shopping cart of a user may hold
        cartItems: z.coerce.number().int().positive(),
        noteLength: z.coerce.number().int().positive(),
        notesPerRequest: z.coerce.number().int().positive(),
        nameLength: z.coerce.number().int().positive(),
        descriptionLength: z.coerce.number().int().positive(),
        // The ids of price plans that one query to the catalog asks for
        plansPerQuery: z.coerce.number().int().positive(),
        // The directory of providers keeps the organisations that have launched offerings for this long, and asks for this many of them in a query
        providersPerQuery: z.coerce.number().int().positive(),
        providerCacheMs: z.coerce.number().int().positive(),
        // When the proxy reads everything that a collection has: the items of a page, and how many pages at most
        readAll: z.object({ pageSize: z.coerce.number().int().positive(), maxPages: z.coerce.number().int().positive() })
    }),
    // The figures of the landing page (offerings and providers) are kept in Mongo and read again, in the background, when they are this old; a read
    // that fails is not tried again before retryDelayMs. The counts of an organisation are kept in memory for providerTtlMs
    // What the portal reads from `GET /config` that the proxy only passes on. `extra` is sent to every visitor as it is, whatever it names, so
    // nothing secret goes in it; a key that the proxy sets itself is not taken from it
    portal: z.object({
        chatUrl: z.string(),
        knowledgeBaseUrl: z.string(),
        ticketingUrl: z.string(),
        matomoId: z.string(),
        matomoUrl: z.string(),
        googleTagManagerId: z.string(),
        theme: z.string(),
        extra: z.record(z.string(), z.unknown())
    }),
    stats: z.object({
        ttlMs: z.coerce.number().int().positive(),
        retryDelayMs: z.coerce.number().int().positive(),
        providerTtlMs: z.coerce.number().int().positive()
    }),
    health: z.object({
        mongoPingTimeoutMs: z.coerce.number().int().positive()
    }),
    upstreams: upstreamsSchema
});

export type AppConfig = z.infer<typeof ConfigSchema>;
