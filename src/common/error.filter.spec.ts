import { BadRequestException, Controller, Get, Module } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../bootstrap';
import { AppConfigModule } from '../config/app-config.module';
import { LoggingModule } from '../logging/logging.module';
import { DomainError, NotFoundError, BadGatewayError } from './domain-error';

@Controller('errors')
class ErrorsController {
    @Get('domain')
    domain(): never {
        throw new DomainError('The offering is not valid');
    }

    @Get('missing')
    missing(): never {
        throw new NotFoundError('Offering 7 not found');
    }

    @Get('upstream')
    upstream(): never {
        throw new BadGatewayError('The catalog could not be reached');
    }

    @Get('http')
    http(): never {
        throw new BadRequestException('Bad filter');
    }

    @Get('unexpected')
    unexpected(): never {
        throw new Error('db password is hunter2');
    }
}

@Module({ imports: [AppConfigModule, LoggingModule], controllers: [ErrorsController] })
class TestRootModule {}

const legacy = express();
legacy.get('/legacy/hello', (_req, res) => {
    res.json({ from: 'legacy' });
});

let app: NestExpressApplication;
let url: string;

beforeAll(async () => {
    app = await createApp(legacy, TestRootModule);
    await app.listen(0);
    url = await app.getUrl();
});

afterAll(async () => {
    await app.close();
});

const get = async (path: string): Promise<{ status: number; body: unknown }> => {
    const res = await fetch(`${url}${path}`);
    return { status: res.status, body: await res.json().catch(() => undefined) };
};

describe('error filter', () => {
    it('answers a domain error with its status and message', async () => {
        expect(await get('/errors/domain')).toEqual({ status: 400, body: { error: 'The offering is not valid' } });
        expect(await get('/errors/missing')).toEqual({ status: 404, body: { error: 'Offering 7 not found' } });
        expect(await get('/errors/upstream')).toEqual({
            status: 502,
            body: { error: 'The catalog could not be reached' }
        });
    });

    it('keeps the status of a client-side HTTP exception', async () => {
        expect(await get('/errors/http')).toEqual({ status: 400, body: { error: 'Bad filter' } });
    });

    it('hides the details of an unexpected error', async () => {
        const { status, body } = await get('/errors/unexpected');
        expect(status).toBe(500);
        expect(body).toEqual({ error: 'Unexpected error. The error has been notified to the administrators.' });
    });

    it('still hands unknown routes to the legacy app', async () => {
        expect(await get('/legacy/hello')).toEqual({ status: 200, body: { from: 'legacy' } });
    });
});
