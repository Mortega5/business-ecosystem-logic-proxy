import { z } from 'zod';

export const ConfigSchema = z.object({
    app: z.object({
        host: z.string().min(1).optional(),
        port: z.coerce.number().int().min(1).max(65535),
        shutdownTimeoutMs: z.coerce.number().int().positive()
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
        serverSelectionTimeoutMs: z.coerce.number().int().positive()
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
