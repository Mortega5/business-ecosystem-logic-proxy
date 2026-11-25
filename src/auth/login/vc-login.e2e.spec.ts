import { Module } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import express from 'express';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../bootstrap';
import { AppConfigModule } from '../../config/app-config.module';
import { LoggingModule } from '../../logging/logging.module';
import { FakeUpstream } from '../../testing/fake-upstream';
import { AuthModule } from '../auth.module';
import { PartyRegistry } from '../profile/party-registry';
import { jwksDocument, LEAR_EMPLOYEE, proxyKeyHex, verifierToken } from '../providers/fake-vc-verifier';
import { LoginModule } from './login.module';

@Module({ imports: [AppConfigModule, LoggingModule, AuthModule, LoginModule] })
class Root {}

const CERT_ISSUER = 'did:web:certifier.example.org';
const STATE = 'state-of-the-browser-0001';
const CERT_STATE = 'cert:state-of-the-upload-01';
const legacy = express();
legacy.use((_req, res) => {
    res.json({ from: 'legacy' });
});

const verifier = new FakeUpstream();
let token = '';
let app: NestExpressApplication | undefined;
let url = '';
const ENV_KEYS = [
    'BAE_AUTH__VC__ENABLED',
    'BAE_AUTH__VC__IS_REDIRECTION',
    'BAE_AUTH__VC__CLIENT_ID',
    'BAE_AUTH__VC__PRIVATE_KEY',
    'BAE_AUTH__VC__CALLBACK_URL',
    'BAE_AUTH__VC__VERIFIER_HOST',
    'BAE_AUTH__VC__CERT_ISSUERS',
    'BAE_AUTH__SESSION__SECRET',
    'BAE_AUTH__SESSION__COOKIE_SECURE'
];

const start = async (redirection: boolean): Promise<void> => {
    Object.assign(process.env, {
        BAE_AUTH__VC__ENABLED: 'true',
        BAE_AUTH__VC__IS_REDIRECTION: String(redirection),
        BAE_AUTH__VC__CLIENT_ID: 'bae-client',
        BAE_AUTH__VC__PRIVATE_KEY: proxyKeyHex(),
        BAE_AUTH__VC__CALLBACK_URL: 'https://bae.example.org/auth/vc/callback',
        BAE_AUTH__VC__VERIFIER_HOST: `http://127.0.0.1:${verifier.port}`,
        BAE_AUTH__VC__CERT_ISSUERS: JSON.stringify([CERT_ISSUER]),
        BAE_AUTH__SESSION__SECRET: 's'.repeat(32),
        BAE_AUTH__SESSION__COOKIE_SECURE: 'false'
    });
    app = await createApp(legacy, Root);
    // TMForum is not part of this test: the party of the user is whoever it says
    Object.assign(app.get(PartyRegistry), {
        individualFor: () => Promise.resolve('p-ana'),
        organizationsFor: () => Promise.resolve([])
    });
    await app.listen(0);
    url = await app.getUrl();
};
const stop = async (): Promise<void> => {
    await app?.close();
    app = undefined;
    ENV_KEYS.forEach((key) => delete process.env[key]);
};

const cookieOf = (res: Response): string => (res.headers.getSetCookie()[0] ?? '').split(';')[0] as string;
const get = (path: string, cookie?: string): Promise<Response> =>
    fetch(`${url}${path}`, { redirect: 'manual', headers: cookie === undefined ? {} : { cookie } });

beforeAll(async () => {
    await verifier.start();
    verifier.answer((res) => {
        const path = verifier.seen?.url ?? '';
        if (path === '/.well-known/jwks') {
            return verifier.json(res, 200, JSON.stringify(jwksDocument()));
        }
        if (path === '/token') {
            return verifier.json(
                res,
                200,
                JSON.stringify({ access_token: token, refresh_token: 'refresh-1', expires_in: 3600 })
            );
        }
        verifier.json(res, 404, '{}');
    });
    token = verifierToken(LEAR_EMPLOYEE);
});
afterEach(stop);
afterAll(() => verifier.stop());

describe('the login with a wallet, polling', () => {
    it('logs in the browser that waits when the verifier tells the proxy the code, and only that browser', async () => {
        await start(false);

        const waiting = await get(`/poll?state=${STATE}`);
        expect(waiting.status).toBe(401);
        const first = cookieOf(waiting);
        expect(first).not.toBe('');
        expect(waiting.headers.getSetCookie()[0]).toMatch(/HttpOnly/i);

        expect((await get(`/auth/vc/callback?state=${STATE}&code=code-1`)).status).toBe(200);

        // Another browser that knows the state gets nothing
        expect((await get(`/poll?state=${STATE}`)).status).toBe(401);

        const done = await get(`/poll?state=${STATE}`, first);
        expect(done.status).toBe(200);
        const session = cookieOf(done);
        expect(session).not.toBe(first);

        const me = await get('/logintoken', session);
        expect(me.status).toBe(200);
        expect(await me.json()).toMatchObject({ id: 'did:key:ana', username: 'ana', partyId: 'p-ana', idp: 'local' });
        // The old session is no longer one
        expect((await get('/logintoken', first)).status).toBe(401);
        // A code is good once
        expect((await get(`/poll?state=${STATE}`, session)).status).toBe(401);
    });

    it('does not take a state that cannot be one', async () => {
        await start(false);
        expect((await get('/poll?state=x')).status).toBe(401);
        expect((await get('/auth/vc/callback?state=x&code=c')).status).toBe(400);
        expect((await get(`/auth/vc/callback?state=${STATE}`)).status).toBe(400);
    });

    it('serves the credential of a certification to the poll, once, when the issuer is trusted', async () => {
        token = verifierToken({
            verifiableCredential: {
                issuer: { did: CERT_ISSUER },
                expirationDate: new Date(Date.now() + 86_400_000).toISOString(),
                subject: { product: 'urn:ngsi-ld:product-specification:1', compliance: [] }
            }
        });
        await start(false);
        try {
            expect((await get(`/cert/poll?state=${CERT_STATE}`)).status).toBe(401);
            expect((await get(`/auth/vc/callback?state=${CERT_STATE}&code=code-1`)).status).toBe(200);

            const found = await get(`/cert/poll?state=${CERT_STATE}`);
            expect(found.status).toBe(200);
            expect(await found.json()).toEqual({
                vc: token,
                subject: { product: 'urn:ngsi-ld:product-specification:1', compliance: [] }
            });
            expect((await get(`/cert/poll?state=${CERT_STATE}`)).status).toBe(401);
        } finally {
            token = verifierToken(LEAR_EMPLOYEE);
        }
    });

    it('has no login with a provider, and no request for the wallet, in this mode', async () => {
        await start(false);
        expect((await get('/login')).status).toBe(404);
        expect((await get('/auth/vc/request.jwt')).status).toBe(404);
    });
});

describe('the login with a wallet, redirection', () => {
    it('takes the user in when the verifier sends the browser back, and serves the request that the wallet asks for', async () => {
        await start(true);

        const request = await get('/auth/vc/request.jwt');
        expect(request.status).toBe(200);
        expect(request.headers.get('content-type')).toMatch(/^text\/plain/);
        expect(await request.text()).toMatch(/^eyJ/);

        const back = await get(`/auth/vc/callback?state=${STATE}&code=code-1`);
        expect(back.status).toBe(302);
        expect(back.headers.get('location')).toBe('/dashboard?token=local');
        const me = await get('/logintoken', cookieOf(back));
        expect(me.status).toBe(200);
        expect(await me.json()).toMatchObject({ id: 'did:key:ana' });
    });

    it('sends to the error page a callback that does not complete, and has no polling', async () => {
        await start(true);
        expect((await get('/auth/vc/callback?state=short&code=c')).headers.get('location')).toBe('/error');
        expect((await get(`/auth/vc/callback?state=${STATE}`)).headers.get('location')).toBe('/error');
        expect((await get(`/poll?state=${STATE}`)).status).toBe(404);
        expect((await get(`/cert/poll?state=${CERT_STATE}`)).status).toBe(404);
    });
});
