import { z } from 'zod';

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
    rss: upstreamEntry,
    revenue: upstreamEntry,
    search: upstreamEntry
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
    dsp: z
        .object({ enabled: booleanLike, contractDefinitionSchema: z.url().optional() })
        .refine((dsp) => !dsp.enabled || dsp.contractDefinitionSchema !== undefined, {
            path: ['contractDefinitionSchema'],
            message: 'is required when dsp.enabled is true'
        }),
    launchValidation: z.object({ enabled: booleanLike }),
    dataSpace: z.object({ enabled: booleanLike }),
    catalogManagement: z.object({ enabled: booleanLike }),
    catalog: z.object({
        offeringSchema: z.url(),
        priceCompSchema: z.url(),
        blueprintSchema: z.url()
    }),
    health: z.object({
        mongoPingTimeoutMs: z.coerce.number().int().positive()
    }),
    upstreams: upstreamsSchema
});

export type AppConfig = z.infer<typeof ConfigSchema>;
