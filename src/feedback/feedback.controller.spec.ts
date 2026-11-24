import { Module } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuthModule } from '../auth/auth.module';
import { createApp } from '../bootstrap';
import { AppConfigModule } from '../config/app-config.module';
import { LoggingModule } from '../logging/logging.module';
import { FakeFeedbackModule, keptFeedback } from '../testing/fake-feedback';

@Module({ imports: [AppConfigModule, LoggingModule, AuthModule, FakeFeedbackModule] })
class Root {}

const legacy = express();
legacy.use((_req, res) => {
    res.json({ from: 'legacy' });
});

const JSON_HEADERS = { 'content-type': 'application/json' };
let app: NestExpressApplication;
let url: string;

const send = (body: unknown): Promise<Response> => fetch(`${url}/feedback`, { method: 'POST', headers: JSON_HEADERS, body: typeof body === 'string' ? body : JSON.stringify(body) });

beforeAll(async () => {
    app = await createApp(legacy, Root);
    await app.listen(0);
    url = await app.getUrl();
});

afterAll(() => app.close());

beforeEach(async () => {
    await keptFeedback.deleteMany({});
});

describe('POST /feedback', () => {
    it('is open to anybody and keeps the rating, the kind and the comment with the date', async () => {
        const res = await send({ rating: 4, type: 'campaign', description: 'Nice' });
        const body = (await res.json()) as Record<string, unknown>;

        expect(res.status).toBe(200);
        expect(body).toMatchObject({ rating: 4, type: 'campaign', description: 'Nice' });
        expect(typeof body['id']).toBe('string');
        expect(Number.isNaN(Date.parse(String(body['creation_date'])))).toBe(false);
        expect(await keptFeedback.count()).toBe(1);
    });

    it('keeps no comment or kind that was not sent, and nothing else that is sent', async () => {
        const res = await send({ rating: 5, id: 'forged', creation_date: '1999-01-01', admin: true });
        const body = (await res.json()) as Record<string, unknown>;

        expect(res.status).toBe(200);
        expect(Object.keys(body).toSorted()).toEqual(['creation_date', 'id', 'rating']);
        expect(body['id']).not.toBe('forged');
        expect(body['creation_date']).not.toBe('1999-01-01');
    });

    it('refuses a rating that is not a whole number from 1 to 5, a text that is too long and a body that is not an object', async () => {
        const bodies = [{}, { rating: 0 }, { rating: 6 }, { rating: 2.5 }, { rating: '3' }, { rating: 3, description: 'x'.repeat(10001) }, { rating: 3, type: 'x'.repeat(101) }, { rating: 3, type: { $ne: 1 } }, '[1]', 'not json'];

        for (const body of bodies) {
            expect((await send(body)).status, JSON.stringify(body)).toBe(400);
        }
        expect(await keptFeedback.count()).toBe(0);
    });
});
