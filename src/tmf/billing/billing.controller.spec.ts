import { Module } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuthModule } from '../../auth/auth.module';
import { createApp } from '../../bootstrap';
import { AppConfigModule } from '../../config/app-config.module';
import { LoggingModule } from '../../logging/logging.module';
import { AS_ORGANISATION, useFakeLogin, LOGGED_IN } from '../../testing/fake-login';
import { FakeUpstream } from '../../testing/fake-upstream';
import { BillingModule } from './billing.module';

const upstream = new FakeUpstream();

@Module({ imports: [AppConfigModule, LoggingModule, AuthModule, BillingModule] })
class Root {}

// The legacy application answers anything under /billing
const legacy = express();
legacy.all('/billing/*path', (_req, res) => {
    res.json({ from: 'legacy' });
});

const TARGET = '/tmf-api/customerBillManagement/v4';
const JSON_HEADERS = { 'content-type': 'application/json' };
const BUYER = JSON.stringify({ id: 'b-1', relatedParty: [{ id: 'p-ana', role: 'Buyer' }, { id: 'p-shop', role: 'Seller' }] });

let app: NestExpressApplication;
let url: string;
let requests: { method: string | undefined; url: string | undefined }[];

const answerWith = (status: number, body: string): void =>
    upstream.answer((res) => {
        requests.push({ method: res.req.method, url: res.req.url });
        upstream.json(res, status, body);
    });

beforeAll(async () => {
    await upstream.start();
    Object.assign(process.env, { BAE_UPSTREAMS__TMFORUM__HOST: '127.0.0.1', BAE_UPSTREAMS__TMFORUM__PORT: String(upstream.port) });
    app = await createApp(legacy, Root);
    useFakeLogin(app);
    await app.listen(0);
    url = await app.getUrl();
});

afterAll(async () => {
    await app.close();
    await upstream.stop();
});

beforeEach(() => {
    upstream.reset();
    requests = [];
    answerWith(200, BUYER);
});

const call = (path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) =>
    fetch(`${url}${path}`, { method: init.method ?? 'GET', headers: { ...LOGGED_IN, ...init.headers }, ...(init.body === undefined ? {} : { body: init.body }) });
const sentQuery = (): [string, string][] => [...new URL(`http://x${upstream.seen?.url ?? ''}`).searchParams.entries()];

describe('GET /billing/customerBill, the list', () => {
    it('is the list of the caller as the customer: the filters go on, then the party and its role', async () => {
        const res = await call('/billing/customerBill?limit=1000&offset=0&state=settled,new&relatedParty.id=p-victim&relatedParty.role=buyer');
        expect(res.status).toBe(200);
        expect(upstream.seen?.url?.startsWith(`${TARGET}/customerBill?`)).toBe(true);
        expect(sentQuery()).toEqual([
            ['limit', '1000'],
            ['offset', '0'],
            ['state', 'settled,new'],
            ['relatedParty.id', 'p-ana'],
            ['relatedParty.role', 'Buyer']
        ]);
    });

    it('is the list of the caller as the seller when they ask for it', async () => {
        await call('/billing/customerBill?relatedParty.role=Seller', { headers: AS_ORGANISATION });
        expect(sentQuery()).toEqual([
            ['relatedParty.id', 'p-acme'],
            ['relatedParty.role', 'Seller']
        ]);
    });

    it('is the list as the customer when no role is asked for', async () => {
        await call('/billing/customerBill');
        expect(sentQuery()).toContainEqual(['relatedParty.role', 'Buyer']);
    });

    it.each(['Admin', 'Owner', ''])('refuses the role %j and does not call the upstream', async (role) => {
        const res = await call(`/billing/customerBill?relatedParty.role=${role}`);
        expect(res.status).toBe(403);
        expect(upstream.seen).toBeUndefined();
    });

    it('refuses a filter that carries another parameter', async () => {
        const res = await call('/billing/customerBill?state=a%26relatedParty.id%3Dp-victim');
        expect(res.status).toBe(400);
        expect(upstream.seen).toBeUndefined();
    });

    it('is private', async () => {
        expect((await fetch(`${url}/billing/customerBill`)).status).toBe(401);
        expect(upstream.seen).toBeUndefined();
    });
});

describe('GET /billing/customerBill/:id', () => {
    it('is given to its customer, and nothing of the query is sent', async () => {
        const res = await call('/billing/customerBill/b-1?fields=name&relatedParty.id=p-victim');
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual(JSON.parse(BUYER));
        expect(upstream.seen?.url).toBe(`${TARGET}/customerBill/b-1`);
    });

    it('is given to its seller', async () => {
        answerWith(200, JSON.stringify({ id: 'b-1', relatedParty: [{ id: 'p-ana', role: 'Seller' }] }));
        expect((await call('/billing/customerBill/b-1')).status).toBe(200);
    });

    it.each([
        ['somebody else', JSON.stringify({ id: 'b-1', relatedParty: [{ id: 'p-other', role: 'Buyer' }] })],
        ['no related parties', JSON.stringify({ id: 'b-1' })],
        ['a role that is neither', JSON.stringify({ id: 'b-1', relatedParty: [{ id: 'p-ana', role: 'Admin' }] })],
        ['something that is not JSON', 'not json']
    ])('is refused when the upstream answers with %s, and what it said is not leaked', async (_name, body) => {
        answerWith(200, body);
        const res = await call('/billing/customerBill/b-1');
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ error: 'You are not authorized to access the specified bill' });
    });

    it('passes on what the upstream answers when it is not a success', async () => {
        answerWith(404, '{"error":"missing"}');
        const res = await call('/billing/customerBill/b-1');
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: 'missing' });
    });

    it.each(['..', 'a%20b', 'a;b'])('refuses the id %s and does not call the upstream', async (id) => {
        expect([400, 404]).toContain((await call(`/billing/customerBill/${id}`)).status);
        expect(upstream.seen).toBeUndefined();
    });
});

describe('PATCH /billing/customerBill/:id', () => {
    it('changes the name of a bill of the caller and sends nothing else on', async () => {
        const res = await call('/billing/customerBill/b-1', { method: 'PATCH', headers: JSON_HEADERS, body: '{"billNo":"March"}' });
        expect(res.status).toBe(200);
        expect(requests.map((request) => request.method)).toEqual(['GET', 'PATCH']);
        expect(upstream.seen?.url).toBe(`${TARGET}/customerBill/b-1`);
        expect(upstream.seen?.body).toBe('{"billNo":"March"}');
    });

    it.each([
        ['another field', '{"state":"settled"}'],
        ['the name and another field', '{"billNo":"a","state":"settled"}'],
        ['a name that is not a text', '{"billNo":7}'],
        ['an empty name', '{"billNo":"  "}'],
        ['a name that is too long', JSON.stringify({ billNo: 'x'.repeat(101) })],
        ['a list', '[{"billNo":"a"}]'],
        ['something that is not JSON', 'not json']
    ])('refuses %s, and nothing is read or sent', async (_name, body) => {
        const res = await call('/billing/customerBill/b-1', { method: 'PATCH', headers: JSON_HEADERS, body });
        expect(res.status).toBe(400);
        expect(upstream.seen).toBeUndefined();
    });

    it('is refused to somebody who is not a party of the bill, and nothing is changed', async () => {
        answerWith(200, JSON.stringify({ id: 'b-1', relatedParty: [{ id: 'p-other', role: 'Buyer' }] }));
        const res = await call('/billing/customerBill/b-1', { method: 'PATCH', headers: JSON_HEADERS, body: '{"billNo":"March"}' });
        expect(res.status).toBe(403);
        expect(requests.map((request) => request.method)).toEqual(['GET']);
    });

    it('passes on the answer to the read when it is not a success', async () => {
        answerWith(404, '{"error":"missing"}');
        const res = await call('/billing/customerBill/b-1', { method: 'PATCH', headers: JSON_HEADERS, body: '{"billNo":"March"}' });
        expect(res.status).toBe(404);
        expect(requests.map((request) => request.method)).toEqual(['GET']);
    });
});

describe('GET /billing/appliedCustomerBillingRate', () => {
    it('gives the rates of a bill to a party of it, with the bill and the page only', async () => {
        const res = await call('/billing/appliedCustomerBillingRate?bill.id=b-1&limit=10&offset=0');
        expect(res.status).toBe(200);
        expect(requests.map((request) => request.url)).toEqual([`${TARGET}/customerBill/b-1`, `${TARGET}/appliedCustomerBillingRate?bill.id=b-1&limit=10&offset=0`]);
    });

    it('refuses the rates of the bill of somebody else', async () => {
        answerWith(200, JSON.stringify({ id: 'b-1', relatedParty: [{ id: 'p-other', role: 'Buyer' }] }));
        const res = await call('/billing/appliedCustomerBillingRate?bill.id=b-1');
        expect(res.status).toBe(403);
        expect(requests).toHaveLength(1);
    });

    it.each(['', '?limit=5', '?bill.id=a%20b', '?bill.id=b-1&relatedParty=p-victim', '?bill.id=b-1&bill.id=b-2', '?bill.id=b-1&limit=-1', '?bill.id=b-1&sort=date'])(
        'refuses the query %j and does not call the upstream',
        async (query) => {
            expect((await call(`/billing/appliedCustomerBillingRate${query}`)).status).toBe(400);
            expect(upstream.seen).toBeUndefined();
        }
    );
});

describe('the rest of /billing', () => {
    it.each([
        ['POST', '/billing/customerBill'],
        ['DELETE', '/billing/customerBill/b-1'],
        ['PUT', '/billing/customerBill/b-1'],
        ['GET', '/billing/other'],
        ['GET', '/billing']
    ])('is closed: %s %s', async (method, path) => {
        const res = await call(path, { method, ...(method === 'GET' || method === 'DELETE' ? {} : { headers: JSON_HEADERS, body: '{}' }) });
        expect(res.status).toBe(404);
        expect(await res.json()).not.toEqual({ from: 'legacy' });
        expect(upstream.seen).toBeUndefined();
    });
});
