import { BadRequestException, Controller, Get, Logger, Module, ServiceUnavailableException } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../bootstrap';
import { AppConfigModule } from '../config/app-config.module';
import { LoggingModule } from '../logging/logging.module';
import { DomainError, ForbiddenError, NotFoundError, BadGatewayError } from './domain-error';

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

    @Get('forbidden')
    forbidden(): never {
        throw new ForbiddenError('You are not the owner');
    }

    @Get('http')
    http(): never {
        throw new BadRequestException('Bad filter');
    }

    @Get('too-large')
    tooLarge(): never {
        // What the body parser throws for a body over the limit
        throw Object.assign(new Error('request entity too large'), { status: 413, expose: true });
    }

    @Get('hidden')
    hidden(): never {
        // A 4xx that is not meant to be shown is not shown
        throw Object.assign(new Error('internal detail'), { status: 400, expose: false });
    }

    @Get('unavailable')
    unavailable(): never {
        throw new ServiceUnavailableException({ status: 'error', details: { mongodb: { status: 'down' } } });
    }

    @Get('unexpected')
    unexpected(): never {
        throw new Error('db password is hunter2');
    }
}

@Module({ imports: [AppConfigModule, LoggingModule], controllers: [ErrorsController] })
class TestRootModule {}

let app: NestExpressApplication;
let url: string;

beforeAll(async () => {
    app = await createApp(TestRootModule);
    await app.listen(0);
    url = await app.getUrl();
});

afterAll(async () => {
    await app.close();
});

const get = async (path: string): Promise<{ status: number, body: unknown }> => {
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

    it('writes down what failed at a third party with the error, and nothing of what the user did wrong', async () => {
        const warn = vi.spyOn(Logger.prototype, 'warn');
        await get('/errors/upstream?access_token=secret');
        await get('/errors/forbidden');
        await get('/errors/missing');
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith(
            { err: expect.objectContaining({ message: 'The catalog could not be reached' }), status: 502 },
            'The request failed at a third party or at the proxy',
            'ErrorFilter'
        );
        warn.mockRestore();
    });

    it('writes down an unexpected error as an error object, with its stack', async () => {
        const error = vi.spyOn(Logger.prototype, 'error');
        await get('/errors/unexpected');
        expect(error).toHaveBeenCalledWith(
            { err: expect.objectContaining({ message: 'db password is hunter2', stack: expect.any(String) }) },
            'The request failed with an unexpected error',
            'ErrorFilter'
        );
        error.mockRestore();
    });

    it('keeps the status of a client-side HTTP exception', async () => {
        expect(await get('/errors/http')).toEqual({ status: 400, body: { error: 'Bad filter' } });
    });

    it('keeps the body an HTTP exception of 5xx was thrown with, as a failing health check does', async () => {
        expect(await get('/errors/unavailable')).toEqual({
            status: 503,
            body: { status: 'error', details: { mongodb: { status: 'down' } } }
        });
    });

    it('tells the client the 4xx errors of the body parser, and only those meant to be told', async () => {
        expect(await get('/errors/too-large')).toEqual({ status: 413, body: { error: 'request entity too large' } });
        const hidden = await get('/errors/hidden');
        expect(hidden.status).toBe(500);
        expect(hidden.body).toEqual({ error: 'Unexpected error. The error has been notified to the administrators.' });
    });

    it('hides the details of an unexpected error', async () => {
        const { status, body } = await get('/errors/unexpected');
        expect(status).toBe(500);
        expect(body).toEqual({ error: 'Unexpected error. The error has been notified to the administrators.' });
    });

    it('answers an unknown route with a 404', async () => {
        expect((await get('/errors/nothing')).status).toBe(404);
    });
});
