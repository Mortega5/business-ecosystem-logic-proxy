import jwt from 'jsonwebtoken';
import type { IdentityClaims } from '../profile/user-profile';
import type {
    IdentityProvider,
    IdentityTokens,
    LoginCapable,
    LoginChecks,
    LoginOutcome,
    LoginStart
} from './identity-provider';
import { organizationsOf, rolesOf, text } from './claim-readers';
import { IdpError, requestJson, tokensOf, type Fetcher } from './idp-http';
import { OAuth2Login } from './oauth2-login';

export interface FiwareOptions {
    id: string;
    /** Base URL of the identity manager (Keyrock). */
    server: string;
    clientId: string;
    clientSecret: string;
    timeoutMs: number;
    /** What is asked at the login. */
    scope: string;
    /** With a key, the access token is a JWT signed with it; without, the identity manager is asked. */
    key?: string;
    /** Role of a user that arrives without roles. */
    defaultRole?: string;
    fetcher?: Fetcher;
}

type Json = Record<string, unknown>;

/**
 * FIWARE identity manager. In OIDC mode the access token is a JWT signed with the key of the manager and is checked here, with no
 * call; otherwise the manager is asked for the user of the token. The roles and the organisations come as the manager says them.
 */
export class FiwareProvider implements IdentityProvider, LoginCapable {
    readonly id: string;
    protected readonly server: string;
    protected readonly fetcher: Fetcher;
    private readonly login: OAuth2Login;

    constructor(protected readonly options: FiwareOptions) {
        this.id = options.id;
        this.server = options.server.replace(/\/+$/, '');
        this.fetcher = options.fetcher ?? fetch;
        this.login = new OAuth2Login({
            authorizationUrl: `${this.server}/oauth2/authorize`,
            tokenUrl: `${this.server}/oauth2/token`,
            clientId: options.clientId,
            clientSecret: options.clientSecret,
            scope: options.scope,
            // The manager is given the client in the header and in the body, as v11 did
            clientAuth: 'basic',
            tokenParams: { client_id: options.clientId, client_secret: options.clientSecret },
            timeoutMs: options.timeoutMs,
            fetcher: this.fetcher
        });
    }

    async claimsOf(accessToken: string): Promise<IdentityClaims> {
        const json =
            this.options.key === undefined ? await this.ask(accessToken) : this.verify(accessToken, this.options.key);
        return this.claimsFrom(json);
    }

    beginLogin(redirectUri: string): Promise<LoginStart> {
        return Promise.resolve(this.login.start(redirectUri));
    }

    async finishLogin(callbackUrl: string, checks: LoginChecks): Promise<LoginOutcome> {
        const tokens = await this.login.finish(callbackUrl, checks);
        return { tokens, claims: await this.claimsOf(tokens.accessToken) };
    }

    async refresh(refreshToken: string): Promise<IdentityTokens> {
        const { clientId, clientSecret } = this.options;
        const answer = await requestJson(
            this.fetcher,
            `${this.server}/oauth2/token`,
            {
                method: 'POST',
                headers: {
                    authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
                    'content-type': 'application/x-www-form-urlencoded',
                    accept: 'application/json'
                },
                body: new URLSearchParams({
                    grant_type: 'refresh_token',
                    refresh_token: refreshToken,
                    client_id: clientId,
                    client_secret: clientSecret
                })
            },
            this.options.timeoutMs
        );
        return tokensOf(answer);
    }

    /** What the manager says of a user, as claims; a provider that adds fields overrides it. */
    protected claimsFrom(json: Json): IdentityClaims {
        const id = text(json['id']);
        if (id === undefined) {
            throw new IdpError('The identity provider gave a user without id');
        }
        const username = text(json['username']) ?? text(json['displayName']) ?? id;
        const roles = rolesOf(json['roles']);
        const email = text(json['email']);
        const displayName = text(json['displayName']);
        const { defaultRole } = this.options;

        return {
            id,
            username,
            ...(displayName === undefined ? {} : { displayName }),
            ...(email === undefined ? {} : { email }),
            roles: roles.length === 0 && defaultRole !== undefined ? [{ id: defaultRole, name: defaultRole }] : roles,
            organizations: organizationsOf(json['organizations']),
            ...(typeof json['exp'] === 'number' ? { expire: json['exp'] } : {})
        };
    }

    private verify(accessToken: string, key: string): Json {
        // Only the HMAC algorithms: the key is a shared secret, so a token that claims another algorithm is not the manager's
        const decoded = jwt.verify(accessToken, key, { algorithms: ['HS256', 'HS384', 'HS512'] });
        if (typeof decoded !== 'object') {
            throw new IdpError('The access token is not a JWT with claims');
        }
        return decoded as Json;
    }

    private ask(accessToken: string): Promise<Json> {
        return requestJson(
            this.fetcher,
            `${this.server}/user?access_token=${encodeURIComponent(accessToken)}`,
            {},
            this.options.timeoutMs
        );
    }
}
