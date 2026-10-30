import { z } from 'zod';

// Environment variables always arrive as strings, and z.coerce.boolean() reads "false" as true
const booleanLike = z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .transform((value) => value === true || value === 'true');

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
        bodyLimit: z.string().min(1)
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
    health: z.object({
        mongoPingTimeoutMs: z.coerce.number().int().positive()
    }),
    upstreams: z.record(
        z.string(),
        z.object({
            baseUrl: z.url(),
            timeoutMs: z.coerce.number().int().positive()
        })
    )
});

export type AppConfig = z.infer<typeof ConfigSchema>;
