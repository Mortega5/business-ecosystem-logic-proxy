import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { Controller, Get, HttpException, Module, Res, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { LoggerModule } from 'nestjs-pino';
import pino from 'pino';
import pinoHttp from 'pino-http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '../config/config.schema';
import { buildPinoOptions, noteFailure, sanitizeUrl } from './pino-options';

const LOGGING: AppConfig['logging'] = { level: 'info', format: 'json', prettyOptions: {} };

const captureStream = () => {
    const lines: Record<string, unknown>[] = [];
    const stream = new Writable({
        write(chunk: Buffer, _encoding, done) {
            lines.push(JSON.parse(chunk.toString()) as Record<string, unknown>);
            done();
        }
    });
    return { lines, stream };
};

describe('sanitizeUrl', () => {
    it('masks sensitive query parameters and keeps the rest', () => {
        expect(sanitizeUrl('/cb?code=abc&state=s1&access_token=xyz')).toBe(
            '/cb?code=%5BRedacted%5D&state=s1&access_token=%5BRedacted%5D'
        );
    });

    it('leaves urls without a query untouched', () => {
        expect(sanitizeUrl('/catalog/productOffering')).toBe('/catalog/productOffering');
    });
});

describe('buildPinoOptions', () => {
    it('uses the pino-pretty transport only for the pretty format', () => {
        expect(buildPinoOptions(LOGGING).transport).toBeUndefined();
        const pretty = buildPinoOptions({ ...LOGGING, format: 'pretty', prettyOptions: { singleLine: true } });
        expect(pretty.transport).toEqual({ target: 'pino-pretty', options: { singleLine: true } });
    });

    it('writes readable lines through the pino-pretty transport', async () => {
        const destination = join(mkdtempSync(join(tmpdir(), 'bae-log-')), 'out.log');
        const options = buildPinoOptions({
            ...LOGGING,
            format: 'pretty',
            prettyOptions: { singleLine: true, colorize: false, destination, sync: true }
        });
        // pino-http is the package that creates the logger, so it is the one resolving the target
        const { logger } = pinoHttp(options);

        logger.info('pretty transport works');
        await new Promise((resolve) => setTimeout(resolve, 500));

        expect(readFileSync(destination, 'utf8')).toContain('pretty transport works');
    });

    it('does not write access lines for the health probes', () => {
        const ignore = (buildPinoOptions(LOGGING).autoLogging as { ignore: (req: { url?: string }) => boolean }).ignore;

        expect(ignore({ url: '/health/live' })).toBe(true);
        expect(ignore({ url: '/health/ready?verbose=1' })).toBe(true);
        expect(ignore({ url: '/catalog/productOffering' })).toBe(false);
    });

    it('takes the level from the configuration', () => {
        expect(buildPinoOptions({ ...LOGGING, level: 'debug' }).level).toBe('debug');
    });

    it('redacts credentials in logged objects', () => {
        const { lines, stream } = captureStream();
        const { redact } = buildPinoOptions(LOGGING);
        const logger = pino(redact === undefined ? {} : { redact }, stream);

        logger.info({
            req: { headers: { authorization: 'Bearer secret', cookie: 'sid=1', accept: 'json' }, body: { password: 'p' } }
        });

        expect(lines[0]).toMatchObject({
            req: {
                headers: { authorization: '[Redacted]', cookie: '[Redacted]', accept: 'json' },
                body: { password: '[Redacted]' }
            }
        });
    });
});

@Controller('catalog')
class SampleController {
    @Get('ok')
    ok() {
        return { ok: true };
    }

    @Get('missing')
    missing() {
        throw new Error('boom');
    }

    @Get('refused')
    refused(@Res({ passthrough: true }) res: { locals?: Record<string, unknown> }) {
        noteFailure(res, 'You are not the owner');
        throw new HttpException('You are not the owner', 403);
    }
}

@Module({ controllers: [SampleController] })
class SampleModule {}

describe('request logging', () => {
    const { lines, stream } = captureStream();
    let app: INestApplication;
    let url: string;

    // nestjs-pino keeps a single root logger per process, so one app serves all the specs.
    beforeAll(async () => {
        const module = await Test.createTestingModule({
            imports: [LoggerModule.forRoot({ pinoHttp: [buildPinoOptions(LOGGING), stream] }), SampleModule]
        }).compile();
        app = module.createNestApplication();
        app.use((req: { user?: { partyId: string; userId: string } }, _res: unknown, next: () => void) => {
            req.user = { partyId: 'urn:party:1', userId: 'user-9' };
            next();
        });
        await app.listen(0);
        url = await app.getUrl();
    });

    afterAll(async () => {
        await app.close();
    });

    beforeEach(() => {
        lines.length = 0;
    });

    const call = async (path: string, headers: Record<string, string> = {}): Promise<Response> => {
        const res = await fetch(`${url}${path}`, { headers });
        await res.text();
        await new Promise((resolve) => setTimeout(resolve, 50));
        return res;
    };

    it('writes one access line with the client, the party and the status', async () => {
        await call('/catalog/ok?code=secret', { 'user-agent': 'vitest' });

        const line = lines.find((l) => l.msg === 'request completed');
        expect(line).toMatchObject({
            level: 30,
            partyId: 'urn:party:1',
            userId: 'user-9',
            req: { method: 'GET', url: '/catalog/ok?code=%5BRedacted%5D', userAgent: 'vitest' },
            res: { statusCode: 200 }
        });
        expect(JSON.stringify(line)).not.toContain('secret');
        expect((line as { req: { clientIp?: string } }).req.clientIp).toBeTruthy();
    });

    it('reuses an incoming request id and returns it', async () => {
        const res = await call('/catalog/ok', { 'x-request-id': 'req-123' });

        expect(res.headers.get('x-request-id')).toBe('req-123');
        expect(lines.find((l) => l.msg === 'request completed')).toMatchObject({ req: { id: 'req-123' } });
    });

    it('generates a request id when none is sent', async () => {
        const res = await call('/catalog/ok');

        expect(res.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('logs server errors at error level', async () => {
        const res = await call('/catalog/missing');

        expect(res.status).toBe(500);
        expect(lines.some((l) => l.level === 50 && l.res !== undefined)).toBe(true);
    });

    it('adds the reason of an error answer to its access line', async () => {
        const res = await call('/catalog/refused');

        expect(res.status).toBe(403);
        expect(lines.find((l) => l.msg === 'request completed')).toMatchObject({
            level: 40,
            failure: 'You are not the owner',
            res: { statusCode: 403 }
        });
    });
});
