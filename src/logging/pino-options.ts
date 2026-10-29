import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { LoggerOptions } from 'pino';
import type { Options } from 'pino-http';
import type { AppConfig } from '../config/config.schema';

const REDACT_PATHS = [
    'req.headers.authorization',
    'req.headers.cookie',
    'res.headers["set-cookie"]',
    'req.body.password',
    'req.body.currentPassword',
    'req.body.newPassword',
    'req.body.refreshToken',
    'req.body.client_secret'
];

const SENSITIVE_QUERY_PARAMS = new Set([
    'access_token',
    'refresh_token',
    'id_token',
    'token',
    'code',
    'client_secret',
    'password'
]);

interface ExpressRequest extends IncomingMessage {
    originalUrl?: string;
    ip?: string;
    apiUrl?: string;
    user?: { partyId?: string };
}

interface SerializedRequest {
    id?: unknown;
    method?: string;
    url?: string;
    headers?: Record<string, string | string[] | undefined>;
    remoteAddress?: string;
    raw?: ExpressRequest;
}

interface SerializedResponse {
    statusCode?: number;
    headers?: Record<string, string | number | string[] | undefined>;
}

export const sanitizeUrl = (url: string): string => {
    const queryStart = url.indexOf('?');
    if (queryStart === -1) {
        return url;
    }
    const params = new URLSearchParams(url.slice(queryStart + 1));
    for (const key of [...params.keys()]) {
        if (SENSITIVE_QUERY_PARAMS.has(key)) {
            params.set(key, '[Redacted]');
        }
    }
    return `${url.slice(0, queryStart)}?${params.toString()}`;
};

const serializeRequest = (req: SerializedRequest) => {
    const raw = req.raw;
    const socketIp = raw?.socket.remoteAddress ?? req.remoteAddress;
    const clientIp = raw?.ip ?? socketIp;
    return {
        id: req.id,
        method: req.method,
        url: sanitizeUrl(raw?.originalUrl ?? req.url ?? ''),
        clientIp,
        ...(socketIp !== undefined && socketIp !== clientIp ? { proxyIp: socketIp } : {}),
        userAgent: req.headers?.['user-agent']
    };
};

const serializeResponse = (res: SerializedResponse) => ({
    statusCode: res.statusCode,
    contentLength: res.headers?.['content-length']
});

// Runs when the line is written, after authentication has populated req.user.
const accessLogProps = (req: IncomingMessage) => {
    const { user, apiUrl } = req as ExpressRequest;
    const api = apiUrl?.split('/')[1];
    return {
        ...(user?.partyId === undefined ? {} : { partyId: user.partyId }),
        ...(api === undefined || api === '' ? {} : { api })
    };
};

const generateRequestId = (req: IncomingMessage, res: ServerResponse): string => {
    const incoming = req.headers['x-request-id'];
    const id = typeof incoming === 'string' && incoming !== '' ? incoming : randomUUID();
    res.setHeader('x-request-id', id);
    return id;
};

const levelForStatus = (_req: IncomingMessage, res: ServerResponse, error?: Error): 'info' | 'warn' | 'error' => {
    if (error !== undefined || res.statusCode >= 500) {
        return 'error';
    }
    return res.statusCode >= 400 ? 'warn' : 'info';
};

export const buildLoggerOptions = (logging: AppConfig['logging']): LoggerOptions => ({
    level: logging.level,
    ...(logging.format === 'pretty' ? { transport: { target: 'pino-pretty', options: logging.prettyOptions } } : {})
});

export const buildPinoOptions = (logging: AppConfig['logging']): Options => ({
    ...buildLoggerOptions(logging),
    redact: { paths: REDACT_PATHS, censor: '[Redacted]' },
    genReqId: generateRequestId,
    customLogLevel: levelForStatus,
    serializers: { req: serializeRequest, res: serializeResponse },
    customProps: accessLogProps
});
