import type { PinoLogger } from 'nestjs-pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DomainError, NotFoundError, UnauthorizedError } from '../../common/domain-error';
import type { AppConfigService } from '../../config/app-config.service';
import type { ProfileService } from '../profile/profile.service';
import type { UserProfile } from '../profile/user-profile';
import { jwksDocument, LEAR_EMPLOYEE, proxyKeys, verifierToken } from '../providers/fake-vc-verifier';
import { IdentityProviderRegistry } from '../providers/identity-provider-registry';
import { VcProvider } from '../providers/vc-provider';
import { MemoryAuthStore } from '../store/memory-auth-store';
import { VcLoginService } from './vc-login.service';

const STATE = 'state-of-the-browser-0001';
const CERT_STATE = 'cert:state-of-the-upload-01';
const ISSUER = 'did:web:certifier.example.org';

const setup = (
    vc: Record<string, unknown> = {},
    token: unknown = { access_token: verifierToken(LEAR_EMPLOYEE), refresh_token: 'r', expires_in: 600 }
) => {
    const exchanges: URLSearchParams[] = [];
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).endsWith('/.well-known/jwks')) {
            return new Response(JSON.stringify(jwksDocument()), { status: 200 });
        }
        exchanges.push(new URLSearchParams(String(init?.body)));
        return new Response(JSON.stringify(token), { status: token === undefined ? 500 : 200 });
    }) as unknown as typeof fetch;
    const registry = new IdentityProviderRegistry();
    registry.add(
        new VcProvider({
            id: 'local',
            clientId: 'bae',
            privateKey: proxyKeys.privateKey,
            signAlgorithm: 'ES256',
            callbackUrl: 'https://bae.example.org/auth/vc/callback',
            verifierHost: 'https://verifier.example.org',
            verifierTokenPath: '/token',
            verifierJwksPath: '/.well-known/jwks',
            policy: {
                roles: {
                    admin: 'admin',
                    customer: 'customer',
                    seller: 'seller',
                    orgAdmin: 'manager',
                    certifier: 'certifier'
                },
                operators: []
            },
            timeoutMs: 1000,
            fetcher
        })
    );
    const profile = { id: 'did:key:ana', accessToken: 'at' } as unknown as UserProfile;
    const admit = vi.fn().mockResolvedValue(profile);
    const store = new MemoryAuthStore(100);
    const config = {
        auth: { vc: { isRedirection: false, bindPollToSession: true, certIssuers: [ISSUER], ...vc } }
    } as unknown as AppConfigService;
    const service = new VcLoginService(registry, { admit } as unknown as ProfileService, store, config, {
        setContext: vi.fn(),
        warn: vi.fn()
    } as unknown as PinoLogger);
    return { service, admit, exchanges, store };
};

describe('VcLoginService: polling', () => {
    let context: ReturnType<typeof setup>;
    beforeEach(() => {
        context = setup();
    });

    it('answers that there is no code yet until the verifier tells the proxy the code, and then logs in the browser that waits', async () => {
        const { service, admit, exchanges } = context;
        await expect(service.poll(STATE, 'browser-1')).rejects.toBeInstanceOf(UnauthorizedError);

        await service.receive(STATE, 'code-1');
        const profile = await service.poll(STATE, 'browser-1');

        expect(profile.accessToken).toBe('at');
        expect(admit).toHaveBeenCalledWith(
            expect.objectContaining({ id: 'did:key:ana' }),
            expect.objectContaining({ refreshToken: 'r' }),
            'local'
        );
        // As v11 asked it: the code and the address, and no assertion
        expect(exchanges[0]?.get('code')).toBe('code-1');
        expect(exchanges[0]?.has('client_assertion')).toBe(false);
    });

    it('gives the code to the browser that asked first and to no other, who is not told that the state is in use', async () => {
        const { service, exchanges } = context;
        await expect(service.poll(STATE, 'browser-1')).rejects.toThrow('No auth code received yet');
        await service.receive(STATE, 'code-1');

        await expect(service.poll(STATE, 'browser-2')).rejects.toThrow('No auth code received yet');
        expect(exchanges).toHaveLength(0);
        await expect(service.poll(STATE, 'browser-1')).resolves.toBeDefined();
    });

    it('binds to the browser that asks first even when the code was there before the first question', async () => {
        const { service } = context;
        await service.receive(STATE, 'code-1');
        await expect(service.poll(STATE, 'browser-1')).resolves.toBeDefined();
    });

    it('does not bind the state to a browser when the setting is off', async () => {
        const open = setup({ bindPollToSession: false });
        await open.service.receive(STATE, 'code-1');
        await expect(open.service.poll(STATE, 'anybody')).resolves.toBeDefined();
    });

    it('gives a code once, even when the exchange fails', async () => {
        const { service } = context;
        await service.poll(STATE, 'browser-1').catch(() => undefined);
        await service.receive(STATE, 'code-1');
        await service.poll(STATE, 'browser-1');
        await expect(service.poll(STATE, 'browser-1')).rejects.toBeInstanceOf(UnauthorizedError);

        const failing = setup({}, undefined);
        await failing.service.poll(STATE, 'browser-1').catch(() => undefined);
        await failing.service.receive(STATE, 'code-1');
        await expect(failing.service.poll(STATE, 'browser-1')).rejects.toMatchObject({ status: 500 });
        await expect(failing.service.poll(STATE, 'browser-1')).rejects.toBeInstanceOf(UnauthorizedError);
    });

    it('fails with a 500, which stops the portal, when the token carries no credential, and does not say why', async () => {
        const bad = setup({}, { access_token: verifierToken({ sub: 'x' }) });
        await bad.service.poll(STATE, 'b').catch(() => undefined);
        await bad.service.receive(STATE, 'code-1');
        const failure = await bad.service.poll(STATE, 'b').catch((error: unknown) => error as DomainError);
        expect(failure).toMatchObject({ status: 500, message: 'The login could not be completed' });
        expect(bad.admit).not.toHaveBeenCalled();
    });

    it('refuses a state that cannot be one, so that nothing odd is kept', async () => {
        const { service, store } = context;
        for (const state of [
            undefined,
            '',
            'short',
            'x'.repeat(201),
            'has space in it 1234',
            '../../etc/passwd',
            ['a'],
            42
        ]) {
            await expect(service.poll(state, 'b')).rejects.toBeInstanceOf(UnauthorizedError);
            await expect(service.receive(state, 'code')).rejects.toMatchObject({ status: 400 });
        }
        await expect(service.receive(STATE, '')).rejects.toMatchObject({ status: 400 });
        await expect(service.receive(STATE, undefined)).rejects.toMatchObject({ status: 400 });
        expect(await store.get(`vc:code:${STATE}`)).toBeUndefined();
    });

    it('does not exist in the mode where the user comes back to the proxy', async () => {
        const redirecting = setup({ isRedirection: true });
        await expect(redirecting.service.poll(STATE, 'b')).rejects.toBeInstanceOf(NotFoundError);
        await expect(redirecting.service.receive(STATE, 'c')).rejects.toBeInstanceOf(NotFoundError);
        await expect(redirecting.service.pollCertificate(CERT_STATE)).rejects.toBeInstanceOf(NotFoundError);
    });
});

describe('VcLoginService: redirection', () => {
    it('logs the user in with the code, proving who the proxy is, and has a request for the wallet', async () => {
        const { service, exchanges, admit } = setup({ isRedirection: true });
        expect(service.redirects).toBe(true);
        expect(service.requestObject()).toMatch(/^eyJ/);

        const profile = await service.finishRedirection(STATE, 'code-1');

        expect(profile.accessToken).toBe('at');
        expect(exchanges[0]?.has('client_assertion')).toBe(true);
        expect(exchanges[0]?.has('redirect_uri')).toBe(false);
        expect(admit).toHaveBeenCalledOnce();
    });

    it('refuses a callback without state or code, and does not exist in the polling mode', async () => {
        const { service } = setup({ isRedirection: true });
        await expect(service.finishRedirection(undefined, 'code')).rejects.toBeInstanceOf(UnauthorizedError);
        await expect(service.finishRedirection(STATE, undefined)).rejects.toBeInstanceOf(UnauthorizedError);
        const polling = setup();
        await expect(polling.service.finishRedirection(STATE, 'code')).rejects.toBeInstanceOf(NotFoundError);
        expect(() => polling.service.requestObject()).toThrow(NotFoundError);
    });
});

describe('VcLoginService: the credential of a certification', () => {
    const certificate = () => ({
        verifiableCredential: {
            issuer: { did: ISSUER },
            expirationDate: new Date(Date.now() + 86_400_000).toISOString(),
            subject: { product: 'urn:ngsi-ld:product-specification:1', compliance: [] }
        }
    });

    it('reads the credential when the verifier tells the code and gives it once to the poll', async () => {
        const token = verifierToken(certificate());
        const { service } = setup({}, { access_token: token });
        await service.receive(CERT_STATE, 'code-1');

        expect(await service.pollCertificate(CERT_STATE)).toEqual({
            vc: token,
            subject: { product: 'urn:ngsi-ld:product-specification:1', compliance: [] }
        });
        await expect(service.pollCertificate(CERT_STATE)).rejects.toMatchObject({
            status: 401,
            message: 'VC not found'
        });
    });

    it('refuses an issuer that is not trusted, and every issuer when none is', async () => {
        const token = verifierToken(certificate());
        const untrusted = setup({ certIssuers: [] }, { access_token: token });
        await untrusted.service.receive(CERT_STATE, 'code-1');
        await expect(untrusted.service.pollCertificate(CERT_STATE)).rejects.toMatchObject({
            status: 400,
            message: 'Invalid VC issuer'
        });
    });

    it('refuses a token that the verifier did not sign', async () => {
        const { service } = setup({}, { access_token: verifierToken(certificate(), { kid: 'unknown-key' }) });
        await service.receive(CERT_STATE, 'code-1');
        await expect(service.pollCertificate(CERT_STATE)).rejects.toMatchObject({ status: 400, message: 'Invalid VC' });
    });

    it('is a 500 when the verifier gives no token, and a 400 when the state is not one', async () => {
        const { service } = setup({}, undefined);
        await expect(service.receive(CERT_STATE, 'code-1')).rejects.toMatchObject({ status: 500 });
        await expect(service.pollCertificate('no')).rejects.toMatchObject({ status: 400 });
    });
});
