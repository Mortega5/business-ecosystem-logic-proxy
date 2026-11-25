import { Module } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { generateKeyPairSync } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../bootstrap';
import { AppConfigModule } from '../../config/app-config.module';
import { LoggingModule } from '../../logging/logging.module';
import { FakeUpstream } from '../../testing/fake-upstream';
import { AuthModule } from '../auth.module';
import { PartyRegistry } from '../profile/party-registry';
import { LoginModule } from './login.module';

@Module({ imports: [AppConfigModule, LoggingModule, AuthModule, LoginModule] })
class Root {}

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const ENV = [
    'BAE_AUTH__IDP__PROVIDER',
    'BAE_AUTH__IDP__SERVER',
    'BAE_AUTH__IDP__CLIENT_ID',
    'BAE_AUTH__IDP__CLIENT_SECRET',
    'BAE_AUTH__IDP__CALLBACK_URL',
    'BAE_AUTH__SESSION__SECRET',
    'BAE_AUTH__SESSION__COOKIE_SECURE'
];
const CALLBACK = 'http://localhost:8004/auth/oidc-discover/callback';

const idp = new FakeUpstream();
let app: NestExpressApplication;
let url: string;
let nonceOfLogin = '';

const cookieOf = (res: Response): string => (res.headers.getSetCookie()[0] ?? '').split(';')[0] as string;
const get = (path: string, cookie?: string): Promise<Response> =>
    fetch(`${url}${path}`, { redirect: 'manual', headers: cookie === undefined ? {} : { cookie } });

/** Starts a login and goes through the provider: what the browser would do, up to the callback. */
const logIn = async (): Promise<{ cookie: string, callback: Response }> => {
    const started = await get('/login');
    const authorize = new URL(started.headers.get('location') as string);
    nonceOfLogin = authorize.searchParams.get('nonce') as string;
    const cookie = cookieOf(started);
    const callback = await get(
        `/auth/oidc-discover/callback?code=abc&state=${authorize.searchParams.get('state')}`,
        cookie
    );
    return { cookie, callback };
};

beforeAll(async () => {
    await idp.start();
    const issuer = `http://127.0.0.1:${idp.port}`;
    idp.answer((res) => {
        const path = idp.seen?.url ?? '';
        if (path.endsWith('/.well-known/openid-configuration')) {
            return idp.json(
                res,
                200,
                JSON.stringify({
                    issuer,
                    authorization_endpoint: `${issuer}/authorize`,
                    token_endpoint: `${issuer}/token`,
                    jwks_uri: `${issuer}/certs`
                })
            );
        }
        if (path === '/token') {
            const now = Math.floor(Date.now() / 1000);
            const idToken = jwt.sign(
                {
                    iss: issuer,
                    aud: 'bae',
                    sub: 'idm-ana',
                    iat: now,
                    exp: now + 300,
                    nonce: nonceOfLogin,
                    preferred_username: 'ana'
                },
                privateKey,
                { algorithm: 'RS256' }
            );
            return idp.json(
                res,
                200,
                JSON.stringify({
                    access_token: 'at-ana',
                    refresh_token: 'rt-ana',
                    token_type: 'Bearer',
                    expires_in: 3600,
                    id_token: idToken
                })
            );
        }
        idp.json(res, 404, '{}');
    });
    Object.assign(process.env, {
        BAE_AUTH__IDP__PROVIDER: 'oidc-discover',
        BAE_AUTH__IDP__SERVER: issuer,
        BAE_AUTH__IDP__CLIENT_ID: 'bae',
        BAE_AUTH__IDP__CLIENT_SECRET: 'shh',
        BAE_AUTH__IDP__CALLBACK_URL: CALLBACK,
        BAE_AUTH__SESSION__SECRET: 's'.repeat(32),
        BAE_AUTH__SESSION__COOKIE_SECURE: 'false'
    });
    app = await createApp(Root);
    // TMForum is not part of this test: the party of the user is whoever it says
    Object.assign(app.get(PartyRegistry), {
        individualFor: () => Promise.resolve('p-ana'),
        organizationsFor: () => Promise.resolve([])
    });
    await app.listen(0);
    url = await app.getUrl();
});

afterAll(async () => {
    await app.close();
    ENV.forEach((key) => delete process.env[key]);
    await idp.stop();
});

describe('the login of the browser', () => {
    it('sends the user to the identity provider, with a state, a nonce and a PKCE challenge, and a session cookie that cannot be read from scripts', async () => {
        const res = await get('/login');
        expect(res.status).toBe(302);
        const target = new URL(res.headers.get('location') as string);
        expect(target.origin).toBe(`http://127.0.0.1:${idp.port}`);
        expect(target.searchParams.get('redirect_uri')).toBe(CALLBACK);
        for (const name of ['state', 'nonce', 'code_challenge']) {
            expect(target.searchParams.get(name)).toBeTruthy();
        }
        expect(res.headers.getSetCookie()[0]).toMatch(/HttpOnly/i);
        expect(res.headers.getSetCookie()[0]).toMatch(/SameSite=Lax/i);
    });

    it('takes the user in at the callback, gives them a new session, and answers who they are from then on', async () => {
        const { cookie, callback } = await logIn();
        expect(callback.status).toBe(302);
        expect(callback.headers.get('location')).toBe('/dashboard?token=local');
        const session = cookieOf(callback);
        expect(session).not.toBe(cookie);

        const me = await get('/logintoken', session);
        expect(me.status).toBe(200);
        expect(await me.json()).toMatchObject({
            id: 'idm-ana',
            username: 'ana',
            accessToken: 'at-ana',
            partyId: 'p-ana',
            idp: 'local'
        });

        // The token alone is enough for a client of the API, as long as the proxy has seen it
        const bearer = await fetch(`${url}/logintoken`, { headers: { authorization: 'Bearer at-ana' } });
        expect(bearer.status).toBe(200);
    });

    it('does not know the user before the login, or by the session that was in use before it', async () => {
        expect((await get('/logintoken')).status).toBe(401);
        const { cookie } = await logIn();
        expect((await get('/logintoken', cookie)).status).toBe(401);
    });

    it('sends to the error page an answer that was not asked for, and one that is used twice', async () => {
        const forged = await get('/auth/oidc-discover/callback?code=abc&state=forged');
        expect(forged.headers.get('location')).toBe('/error');

        const started = await get('/login');
        const cookie = cookieOf(started);
        const state = new URL(started.headers.get('location') as string).searchParams.get('state');
        nonceOfLogin = new URL(started.headers.get('location') as string).searchParams.get('nonce') as string;
        expect(
            (await get(`/auth/oidc-discover/callback?code=abc&state=${state}`, cookie)).headers.get('location')
        ).toBe('/dashboard?token=local');
        expect(
            (await get(`/auth/oidc-discover/callback?code=abc&state=${state}`, cookie)).headers.get('location')
        ).toBe('/error');
    });

    it('ends the session at the logout', async () => {
        const { callback } = await logIn();
        const session = cookieOf(callback);
        const out = await get('/logOut', session);
        expect(out.headers.get('location')).toBe('/');
        expect((await get('/logintoken', session)).status).toBe(401);
    });

    it('does not open a session for a request that does not log in', async () => {
        const res = await get('/version');
        expect(res.headers.getSetCookie()).toEqual([]);
    });
});
