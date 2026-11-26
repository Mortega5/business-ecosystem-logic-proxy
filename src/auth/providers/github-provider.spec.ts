import { describe, expect, it } from 'vitest';
import { GithubProvider } from './github-provider';
import { IdpError } from './idp-http';
import { urlOf } from '../../testing/fetch-input';

interface Call {
    url: string;
    init: RequestInit;
}

const answering = (status: number, body: unknown, calls: Call[] = []): typeof fetch =>
    (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof fetch;

const provider = (fetcher: typeof fetch): GithubProvider =>
    new GithubProvider({
        id: 'local',
        timeoutMs: 1000,
        clientId: 'bae',
        clientSecret: 'shh',
        scope: 'user:email',
        sellerRole: 'Seller',
        fetcher
    });

describe('GithubProvider', () => {
    it('asks the API for the user of the token, with the User-Agent that GitHub demands', async () => {
        const calls: Call[] = [];

        await provider(answering(200, { id: 42, login: 'ana' }, calls)).claimsOf('gho_token');

        const headers = calls[0]?.init.headers as Record<string, string>;
        expect(calls[0]?.url).toBe('https://api.github.com/user');
        expect(headers['authorization']).toBe('Bearer gho_token');
        expect(headers['user-agent']).toBeTruthy();
    });

    it('makes a seller with no organisations of every user, named by the number of GitHub', async () => {
        const claims = await provider(
            answering(200, { id: 42, login: 'ana', name: 'Ana López', email: 'ana@example.org' })
        ).claimsOf('t');

        expect(claims).toEqual({
            id: '42',
            username: 'ana',
            displayName: 'Ana López',
            email: 'ana@example.org',
            roles: [{ id: 'Seller', name: 'Seller' }],
            organizations: []
        });
    });

    it('leaves out the name and the email that GitHub keeps private, and uses the id when there is no login', async () => {
        const claims = await provider(answering(200, { id: 7, name: null, email: null })).claimsOf('t');

        expect(claims).toEqual({
            id: '7',
            username: '7',
            roles: [{ id: 'Seller', name: 'Seller' }],
            organizations: []
        });
    });

    it('rejects a token that GitHub does not accept, and an answer without a user', async () => {
        await expect(provider(answering(401, { message: 'Bad credentials' })).claimsOf('t')).rejects.toBeInstanceOf(
            IdpError
        );
        await expect(provider(answering(200, { login: 'ana' })).claimsOf('t')).rejects.toBeInstanceOf(IdpError);
    });

    it('does not refresh, as GitHub tokens do not end', async () => {
        await expect(provider(answering(200, {})).refresh()).rejects.toBeInstanceOf(IdpError);
    });

    it('logs in through GitHub: asks the user to authorize and gives the token with the user it belongs to', async () => {
        const urls: string[] = [];
        const fetcher = ((input: RequestInfo | URL) => {
            urls.push(urlOf(input));
            const body = urlOf(input).endsWith('/access_token')
                ? { access_token: 'gho_token', token_type: 'bearer' }
                : { id: 42, login: 'ana' };
            return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
        }) as typeof fetch;
        const github = provider(fetcher);
        const redirect = 'https://bae.example.org/auth/github/callback';

        const { url, checks } = await github.beginLogin(redirect);
        expect(url.startsWith('https://github.com/login/oauth/authorize?')).toBe(true);
        expect(new URL(url).searchParams.get('scope')).toBe('user:email');

        const outcome = await github.finishLogin(`${redirect}?code=abc&state=${checks.state}`, checks);
        expect(urls).toEqual(['https://github.com/login/oauth/access_token', 'https://api.github.com/user']);
        expect(outcome.tokens.accessToken).toBe('gho_token');
        expect(outcome.claims).toMatchObject({ id: '42', username: 'ana' });
    });
});
