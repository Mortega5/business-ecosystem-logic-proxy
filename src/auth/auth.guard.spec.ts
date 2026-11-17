import { Controller, Get, Module, Req, Res } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import express from 'express';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../bootstrap';
import { AppConfigModule } from '../config/app-config.module';
import { LegacyAuthBridge, type LegacyMiddleware } from '../legacy/legacy-auth.bridge';
import { LoggingModule } from '../logging/logging.module';
import { AuthModule } from './auth.module';
import { Public } from './public.decorator';

const nodeRequire = createRequire(__filename);
// The legacy dependencies have no type declarations
const cookieParser = nodeRequire('cookie-parser') as () => LegacyMiddleware;
const session = nodeRequire('express-session') as (options: object) => LegacyMiddleware;
const passport = nodeRequire('passport') as {
    serializeUser: (fn: (user: object, done: (error: unknown, user?: object) => void) => void) => void;
    deserializeUser: (fn: (user: object, done: (error: unknown, user?: object) => void) => void) => void;
    initialize: () => LegacyMiddleware;
    session: () => LegacyMiddleware;
};

// The real authentication middlewares of the legacy application, with a fake identity provider
const profiles: Record<string, Record<string, unknown>> = {
    'ana-token': { id: 'u-ana', username: 'ana', email: 'ana@example.org', roles: [], organizations: [], partyId: 'p-ana' }
};
const identityProvider = {
    STRATEGY: {
        userProfile: (token: string, callback: (error: Error | null, profile?: Record<string, unknown>) => void): void => {
            const profile = profiles[token];
            if (profile === undefined) {
                callback(new Error('unknown token'));
                return;
            }
            callback(null, { ...profile });
        }
    }
};
const legacyAuth = (nodeRequire('../../lib/auth') as { authMiddleware: (idps: object) => Record<string, LegacyMiddleware> }).authMiddleware({
    local: identityProvider
});

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((user, done) => done(null, user));

const pipeline: LegacyMiddleware[] = [
    session({ secret: 'test', resave: true, saveUninitialized: true }),
    cookieParser(),
    passport.initialize(),
    passport.session(),
    legacyAuth.headerAuthentication!,
    legacyAuth.setPartyObj!
];

@Controller('probe')
class ProbeController {
    constructor(private readonly bridge: LegacyAuthBridge) {}

    @Get('private')
    private_(@Req() req: { user?: { id: string; username: string } }) {
        return { user: req.user === undefined ? null : { id: req.user.id, username: req.user.username } };
    }

    // What the legacy login callback does once the identity provider has answered
    @Public()
    @Get('login')
    async login(
        @Req() req: IncomingMessage & { login: (user: object, done: (error?: unknown) => void) => void },
        @Res({ passthrough: true }) res: ServerResponse
    ) {
        await this.bridge.run(req, res);
        const user = {
            id: 'u-cookie',
            username: 'cookie',
            roles: [],
            organizations: [],
            expire: Math.floor(Date.now() / 1000) + 3600,
            accessToken: 'cookie-token',
            refreshToken: 'cookie-refresh',
            idp: 'local'
        };
        await new Promise<void>((resolve, reject) => {
            req.login(user, (error) => (error === undefined || error === null ? resolve() : reject(error as Error)));
        });
        return { loggedIn: true };
    }

    @Public()
    @Get('public')
    public_(@Req() req: { user?: { id: string }; session?: unknown }) {
        return { user: req.user?.id ?? null, session: req.session !== undefined };
    }
}

@Module({ imports: [AppConfigModule, LoggingModule, AuthModule], controllers: [ProbeController] })
class Root {}

let app: NestExpressApplication;
let url: string;

beforeAll(async () => {
    app = await createApp(express(), Root);
    app.get(LegacyAuthBridge).attach(pipeline);
    await app.listen(0);
    url = await app.getUrl();
});

afterAll(async () => {
    await app.close();
});

const call = async (path: string, headers: Record<string, string> = {}) => {
    const res = await fetch(`${url}${path}`, { headers });
    return { status: res.status, body: (await res.json().catch(() => undefined)) as unknown, cookie: res.headers.get('set-cookie') };
};

describe('private by default', () => {
    it('lets in a user the legacy middlewares recognise from their token', async () => {
        const result = await call('/probe/private', { Authorization: 'Bearer ana-token' });
        expect(result).toMatchObject({ status: 200, body: { user: { id: 'u-ana', username: 'ana' } } });
    });

    it('refuses a request with no token', async () => {
        expect(await call('/probe/private')).toMatchObject({
            status: 401,
            body: { error: 'You need to be authenticated to perform this request' }
        });
    });

    it('answers what the legacy middleware answers when the token is not valid', async () => {
        expect(await call('/probe/private', { Authorization: 'Bearer nobody' })).toMatchObject({
            status: 401,
            body: { error: 'It has not been possible to obtain your user info' }
        });
        expect(await call('/probe/private', { Authorization: 'Basic abc' })).toMatchObject({ status: 401 });
    });

    it('recognises a user from the session cookie the legacy login created', async () => {
        const login = await call('/probe/login');
        const cookie = login.cookie?.split(';')[0];
        expect(cookie).toBeDefined();
        expect(await call('/probe/private', { Cookie: cookie ?? '' })).toMatchObject({
            status: 200,
            body: { user: { id: 'u-cookie', username: 'cookie' } }
        });
        expect((await call('/probe/private')).status).toBe(401);
    });
});

describe('@Public()', () => {
    it('lets anyone in without running the session and authentication chain', async () => {
        const result = await call('/probe/public', { Authorization: 'Bearer ana-token' });
        expect(result).toMatchObject({ status: 200, body: { user: null, session: false } });
        expect(result.cookie).toBeNull();
    });
});

describe('without the legacy chain', () => {
    it('keeps private routes closed and public ones open', async () => {
        const bare = await createApp(express(), Root);
        await bare.listen(0);
        const bareUrl = await bare.getUrl();
        try {
            expect((await fetch(`${bareUrl}/probe/private`, { headers: { Authorization: 'Bearer ana-token' } })).status).toBe(401);
            expect((await fetch(`${bareUrl}/probe/public`)).status).toBe(200);
        } finally {
            await bare.close();
        }
    });
});
