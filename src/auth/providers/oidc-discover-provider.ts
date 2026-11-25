import type { IdentityClaims } from '../profile/user-profile';
import { organizationsOf, rolesOf, text } from './claim-readers';
import type { IdentityProvider, IdentityTokens, LoginCapable, LoginChecks, LoginOutcome, LoginStart } from './identity-provider';
import { IdpError, requestJson, tokensOf, type Fetcher } from './idp-http';
import { jwtPayload } from './jwt-payload';
import { JwksVerifier } from './jwks-verifier';
import { OidcLogin } from './oidc-login';

export interface OidcDiscoverOptions {
    id: string;
    /** The issuer, whose discovery document is at `/.well-known/openid-configuration`. */
    issuerUrl?: string;
    /** The discovery document, when it is not at the issuer. */
    discoveryUrl?: string;
    clientId: string;
    clientSecret: string;
    tokenAuthMethod: 'client_secret_basic' | 'client_secret_post';
    timeoutMs: number;
    /** Scopes asked at the login. */
    scope: string;
    /** Name of the role of a seller: the role of a user that comes without roles when there is no default one. */
    sellerRole: string;
    defaultRole?: string;
    /** When set, a token presented without a login must be meant for it. */
    audience?: string;
    /** How long the discovery document is kept (an hour by default). */
    cacheMs?: number;
    fetcher?: Fetcher;
    now?: () => number;
}

interface Discovered {
    tokenEndpoint: string;
    verifier: JwksVerifier;
}

type Json = Record<string, unknown>;

const WELL_KNOWN = '/.well-known/openid-configuration';

/**
 * Any OpenID Connect provider, whose endpoints are discovered. A token that somebody presents is checked against the keys the
 * provider publishes (signature, expiry, issuer, and audience when one is set). The claims are the ones of the ID token of a login
 * or of the access token; roles and organisations are read from them when they are there.
 */
export class OidcDiscoverProvider implements IdentityProvider, LoginCapable {
    readonly id: string;
    private readonly fetcher: Fetcher;
    private readonly now: () => number;
    private readonly login: OidcLogin;
    private discovered: { at: number; value: Promise<Discovered> } | undefined;

    constructor(private readonly options: OidcDiscoverOptions) {
        if (options.issuerUrl === undefined && options.discoveryUrl === undefined) {
            throw new Error('OidcDiscoverProvider needs an issuer or a discovery URL');
        }
        this.id = options.id;
        this.fetcher = options.fetcher ?? fetch;
        this.now = options.now ?? Date.now;
        this.login = new OidcLogin({
            issuerUrl: (options.discoveryUrl ?? options.issuerUrl) as string,
            clientId: options.clientId,
            clientSecret: options.clientSecret,
            tokenAuthMethod: options.tokenAuthMethod,
            scope: options.scope,
            timeoutMs: options.timeoutMs,
            ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher })
        });
    }

    async claimsOf(accessToken: string): Promise<IdentityClaims> {
        const { verifier } = await this.discover();
        return this.claimsFrom(await verifier.verify(accessToken));
    }

    beginLogin(redirectUri: string): Promise<LoginStart> {
        return this.login.start(redirectUri);
    }

    async finishLogin(callbackUrl: string, checks: LoginChecks): Promise<LoginOutcome> {
        const { idToken, ...tokens } = await this.login.finish(callbackUrl, checks);
        const claims = idToken === undefined ? undefined : jwtPayload(idToken);
        if (claims === undefined) {
            throw new IdpError('The identity provider gave no ID token');
        }
        // The library has validated the ID token, so its claims are the provider's
        return { tokens, claims: this.claimsFrom(claims) };
    }

    async refresh(refreshToken: string): Promise<IdentityTokens> {
        const { tokenEndpoint } = await this.discover();
        const { clientId, clientSecret, tokenAuthMethod } = this.options;
        const form = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken });
        const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
        if (tokenAuthMethod === 'client_secret_basic') {
            // The credentials are form-encoded before they are joined (RFC 6749, 2.3.1)
            headers['authorization'] = `Basic ${Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`).toString('base64')}`;
        } else {
            form.set('client_id', clientId);
            form.set('client_secret', clientSecret);
        }
        return tokensOf(await requestJson(this.fetcher, tokenEndpoint, { method: 'POST', headers, body: form }, this.options.timeoutMs));
    }

    /** The claims of the ID token of a login, which the login has already validated. */
    claimsFromIdToken(claims: Json): IdentityClaims {
        return this.claimsFrom(claims);
    }

    private claimsFrom(claims: Json): IdentityClaims {
        const id = text(claims['sub']) ?? text(claims['preferred_username']);
        if (id === undefined) {
            throw new IdpError('The token has no user');
        }
        const username = text(claims['preferred_username']) ?? text(claims['username']) ?? id;
        const displayName = text(claims['name']) ?? text(claims['preferred_username']) ?? text(claims['username']);
        const email = text(claims['email']);
        const given = Array.isArray(claims['roles']) ? claims['roles'].map((role: unknown) => (typeof role === 'string' ? { name: role } : role)) : [];
        const roles = rolesOf(given);
        const fallback = this.options.defaultRole ?? this.options.sellerRole;

        return {
            id,
            username,
            ...(displayName === undefined ? {} : { displayName }),
            ...(email === undefined ? {} : { email }),
            roles: roles.length > 0 ? roles : [{ id: fallback, name: fallback }],
            organizations: organizationsOf(claims['organizations']),
            ...(typeof claims['exp'] === 'number' ? { expire: claims['exp'] } : {})
        };
    }

    // The document is asked once for everybody who needs it, and again when it is old or when the last ask failed
    private discover(): Promise<Discovered> {
        const cacheMs = this.options.cacheMs ?? 3_600_000;
        if (this.discovered === undefined || this.now() - this.discovered.at >= cacheMs) {
            const value = this.loadDiscovery();
            this.discovered = { at: this.now(), value };
            value.catch(() => {
                if (this.discovered?.value === value) {
                    this.discovered = undefined;
                }
            });
        }
        return this.discovered.value;
    }

    private async loadDiscovery(): Promise<Discovered> {
        const base = (this.options.discoveryUrl ?? this.options.issuerUrl) as string;
        const url = base.includes('/.well-known/') ? base : `${base.replace(/\/+$/, '')}${WELL_KNOWN}`;
        const document = await requestJson(this.fetcher, url, { headers: { accept: 'application/json' } }, this.options.timeoutMs);
        const issuer = text(document['issuer']);
        const jwksUri = text(document['jwks_uri']);
        const tokenEndpoint = text(document['token_endpoint']);
        if (issuer === undefined || jwksUri === undefined || tokenEndpoint === undefined) {
            throw new IdpError('The discovery document lacks the issuer, the keys or the token endpoint');
        }
        return {
            tokenEndpoint,
            verifier: new JwksVerifier({
                url: jwksUri,
                issuer,
                timeoutMs: this.options.timeoutMs,
                ...(this.options.audience === undefined ? {} : { audience: this.options.audience }),
                ...(this.options.fetcher === undefined ? {} : { fetcher: this.options.fetcher }),
                ...(this.options.now === undefined ? {} : { now: this.options.now })
            })
        };
    }
}
