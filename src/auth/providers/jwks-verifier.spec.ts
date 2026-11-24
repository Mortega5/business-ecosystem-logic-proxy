import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { describe, expect, it } from 'vitest';
import { IdpError } from './idp-http';
import { JwksVerifier, type JwksOptions } from './jwks-verifier';

const pair = (): { publicKey: KeyObject; privateKey: KeyObject } => generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwkOf = (key: KeyObject, kid?: string): object => ({ ...key.export({ format: 'jwk' }), use: 'sig', ...(kid === undefined ? {} : { kid }) });

/** A JWKS endpoint whose keys can change, counting the requests it gets. */
const endpoint = (keys: object[]) => {
    const state = { keys, requests: 0 };
    const fetcher = (async () => {
        state.requests += 1;
        return new Response(JSON.stringify({ keys: state.keys }), { status: 200 });
    }) as unknown as typeof fetch;
    return { state, fetcher };
};

// `keyid: null` signs a token that names no key
const sign = (key: KeyObject, claims: object = { sub: 'u1' }, options: Omit<jwt.SignOptions, 'keyid'> & { keyid?: string | null } = {}): string => {
    const { keyid = 'k1', ...rest } = options;
    return jwt.sign(claims, key.export({ type: 'pkcs8', format: 'pem' }), { algorithm: 'RS256', ...(keyid === null ? {} : { keyid }), ...rest });
};

const verifier = (jwks: ReturnType<typeof endpoint>, extra: Partial<JwksOptions> = {}): JwksVerifier =>
    new JwksVerifier({ url: 'https://idp.example.org/jwks', timeoutMs: 1000, fetcher: jwks.fetcher, ...extra });

describe('JwksVerifier', () => {
    it('gives the claims of a token signed with a key of the identity provider', async () => {
        const { publicKey, privateKey } = pair();

        const claims = await verifier(endpoint([jwkOf(publicKey, 'k1')])).verify(sign(privateKey, { sub: 'u1', role: 'seller' }));

        expect(claims).toMatchObject({ sub: 'u1', role: 'seller' });
    });

    it('rejects a token signed with another key, a changed one, an expired one and one that is not signed', async () => {
        const trusted = pair();
        const forger = pair();
        const jwks = endpoint([jwkOf(trusted.publicKey, 'k1')]);
        const valid = sign(trusted.privateKey);
        const [head, , signature] = valid.split('.') as [string, string, string];
        const changed = `${head}.${Buffer.from('{"sub":"admin"}').toString('base64url')}.${signature}`;

        await expect(verifier(jwks).verify(sign(forger.privateKey))).rejects.toBeDefined();
        await expect(verifier(jwks).verify(changed)).rejects.toBeDefined();
        await expect(verifier(jwks).verify(sign(trusted.privateKey, { sub: 'u1' }, { expiresIn: -10 }))).rejects.toBeDefined();
        await expect(verifier(jwks).verify(jwt.sign({ sub: 'u1' }, '', { algorithm: 'none', keyid: 'k1' }))).rejects.toBeInstanceOf(IdpError);
        await expect(verifier(jwks).verify('not-a-jwt')).rejects.toBeInstanceOf(IdpError);
    });

    it('rejects a token signed with the public key as if it were a shared secret', async () => {
        const { publicKey } = pair();
        const pem = publicKey.export({ type: 'spki', format: 'pem' });
        const forged = jwt.sign({ sub: 'admin' }, pem as string, { algorithm: 'HS256', keyid: 'k1' });

        await expect(verifier(endpoint([jwkOf(publicKey, 'k1')])).verify(forged)).rejects.toBeInstanceOf(IdpError);
    });

    it('checks the issuer and the audience when it is asked to', async () => {
        const { publicKey, privateKey } = pair();
        const jwks = endpoint([jwkOf(publicKey, 'k1')]);
        const token = sign(privateKey, { sub: 'u1' }, { issuer: 'https://idp.example.org', audience: 'bae' });

        await expect(verifier(jwks, { issuer: 'https://idp.example.org', audience: 'bae' }).verify(token)).resolves.toBeDefined();
        await expect(verifier(jwks, { audience: 'another-client' }).verify(token)).rejects.toBeDefined();
        await expect(verifier(jwks, { issuer: 'https://other.example.org' }).verify(token)).rejects.toBeDefined();
        await expect(verifier(jwks, { audience: 'bae' }).verify(sign(privateKey))).rejects.toBeDefined();
    });

    it('asks for the keys once for many tokens, even when they arrive together, and again when the time is over', async () => {
        const { publicKey, privateKey } = pair();
        const jwks = endpoint([jwkOf(publicKey, 'k1')]);
        let time = 1_000_000;
        const checking = verifier(jwks, { cacheMs: 60_000, now: () => time });

        await Promise.all([checking.verify(sign(privateKey)), checking.verify(sign(privateKey)), checking.verify(sign(privateKey))]);
        await checking.verify(sign(privateKey));
        expect(jwks.state.requests).toBe(1);

        time += 60_000;
        await checking.verify(sign(privateKey));
        expect(jwks.state.requests).toBe(2);
    });

    it('finds a new key after the identity provider rotates it, without waiting for the time to be over', async () => {
        const old = pair();
        const fresh = pair();
        const jwks = endpoint([jwkOf(old.publicKey, 'k1')]);
        let time = 1_000_000;
        const checking = verifier(jwks, { now: () => time });
        await checking.verify(sign(old.privateKey));

        jwks.state.keys = [jwkOf(old.publicKey, 'k1'), jwkOf(fresh.publicKey, 'k2')];
        time += 31_000;

        await expect(checking.verify(sign(fresh.privateKey, { sub: 'u1' }, { keyid: 'k2' }))).resolves.toBeDefined();
    });

    it('does not let a forger make it ask for the keys again and again with ids it makes up', async () => {
        const { publicKey, privateKey } = pair();
        const jwks = endpoint([jwkOf(publicKey, 'k1')]);
        let time = 1_000_000;
        const checking = verifier(jwks, { now: () => time });
        await checking.verify(sign(privateKey));

        for (let attempt = 0; attempt < 5; attempt += 1) {
            await expect(checking.verify(sign(privateKey, { sub: 'u1' }, { keyid: `made-up-${attempt}` }))).rejects.toBeInstanceOf(IdpError);
        }

        expect(jwks.state.requests).toBe(1);
    });

    it('takes the only key there is for a token that names none', async () => {
        const { publicKey, privateKey } = pair();

        await expect(verifier(endpoint([jwkOf(publicKey)])).verify(sign(privateKey, { sub: 'u1' }, { keyid: null }))).resolves.toBeDefined();
    });

    it('does not hide that the identity provider does not answer', async () => {
        const failing = { fetcher: (async () => new Response('', { status: 500 })) as unknown as typeof fetch, state: { keys: [], requests: 0 } };
        const { privateKey } = pair();

        await expect(verifier(failing).verify(sign(privateKey))).rejects.toBeInstanceOf(IdpError);
    });
});
