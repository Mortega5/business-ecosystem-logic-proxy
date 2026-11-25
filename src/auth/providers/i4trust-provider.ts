import type { IdentityClaims } from '../profile/user-profile';
import type {
    IdentityProvider,
    IdentityTokens,
    LoginCapable,
    LoginChecks,
    LoginOutcome,
    LoginStart
} from './identity-provider';
import { IdpError, type Fetcher } from './idp-http';
import { IshareSigner } from './ishare-signer';
import { OAuth2Login } from './oauth2-login';
import { randomBytes } from 'node:crypto';
import { jwtPayload } from './jwt-payload';
import type { JwksVerifier } from './jwks-verifier';

export interface I4TrustOptions {
    /** The id the identity provider is registered under: the organisation of its users is named after it. */
    id: string;
    /** Names of the roles of the platform. */
    roles: { seller: string, customer: string, orgAdmin: string };
    /** The keys of the identity provider. Without them a token that somebody presents is not accepted. */
    verifier?: JwksVerifier;
    login: I4TrustLoginOptions;
}

export interface I4TrustLoginOptions {
    /** Base URL of the identity provider. */
    server: string;
    /** EORI of the proxy as a client. */
    clientId: string;
    /** EORI of the identity provider: the audience of what the proxy signs. */
    idpId: string;
    scope: string;
    /** The private key of the proxy and the chain of its certificate, in PEM. */
    keyPem: string;
    certificatePem: string;
    timeoutMs: number;
    fetcher?: Fetcher;
}

/**
 * i4Trust (iSHARE). The user is read from the ID token that the token endpoint gives in the answer to the code, which arrives over
 * TLS from the identity provider itself; that is the only place an identity is taken from. A token that somebody presents later is
 * not accepted unless the keys of the identity provider are configured and sign it: v11 decoded it without checking its signature,
 * so anybody could write the user they wanted in one. Every user is a
 * seller and the administrator of one organisation named after the identity provider.
 */
export class I4TrustProvider implements IdentityProvider, LoginCapable {
    readonly id: string;
    private readonly signer: IshareSigner;
    private readonly login: OAuth2Login;
    private readonly server: string;
    private readonly fetcher: Fetcher;

    constructor(private readonly options: I4TrustOptions) {
        this.id = options.id;
        const { login } = options;
        this.server = login.server.replace(/\/+$/, '');
        this.fetcher = login.fetcher ?? fetch;
        this.signer = new IshareSigner(login.keyPem, login.certificatePem);
        this.login = new OAuth2Login({
            authorizationUrl: `${this.server}/oauth2/authorize`,
            tokenUrl: `${this.server}/oauth2/token`,
            clientId: login.clientId,
            clientSecret: '',
            scope: login.scope,
            // The client proves who it is with a signed JWT instead of a secret, and does not use PKCE
            clientAuth: 'none',
            pkce: false,
            tokenParams: () => ({
                client_id: login.clientId,
                client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
                client_assertion: this.signer.clientAssertion(login.clientId, login.idpId)
            }),
            timeoutMs: login.timeoutMs,
            fetcher: this.fetcher
        });
    }

    /**
     * The authorization is not a link: the proxy posts its signed request to the identity provider, which answers where the user
     * has to go.
     */
    async beginLogin(redirectUri: string): Promise<LoginStart> {
        const { login } = this.options;
        const checks: LoginChecks = {
            state: randomBytes(32).toString('base64url'),
            nonce: randomBytes(32).toString('base64url'),
            codeVerifier: ''
        };
        const params = {
            response_type: 'code',
            redirect_uri: redirectUri,
            scope: login.scope,
            state: checks.state,
            nonce: checks.nonce
        };
        const request = this.signer.request({ clientId: login.clientId, idpId: login.idpId, params });
        const response = await this.fetcher(`${this.server}/oauth2/authorize`, {
            method: 'POST',
            headers: { authorization: `Bearer ${request}`, 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ ...params, client_id: login.clientId, request }),
            redirect: 'manual',
            signal: AbortSignal.timeout(login.timeoutMs)
        });
        const location = response.headers.get('location');
        if (response.status >= 400 || location === null || location === '') {
            throw new IdpError(`The identity provider did not say where to log in (${response.status})`);
        }
        return { url: /^https?:\/\//.test(location) ? location : `${this.server}${location}`, checks };
    }

    async finishLogin(callbackUrl: string, checks: LoginChecks): Promise<LoginOutcome> {
        const { idToken, ...tokens } = await this.login.finish(callbackUrl, checks);
        if (idToken === undefined) {
            throw new IdpError('The identity provider gave no ID token');
        }
        return { tokens, claims: this.claimsFromIdToken(idToken) };
    }

    /** The claims of the ID token of a login. The signature is not checked: the token came from the token endpoint. */
    claimsFromIdToken(idToken: string): IdentityClaims {
        return this.claimsFrom(jwtPayload(idToken));
    }

    private claimsFrom(token: Record<string, unknown> | undefined): IdentityClaims {
        const text = (value: unknown): string | undefined =>
            typeof value === 'string' && value !== '' ? value : undefined;
        const id = text(token?.['sub']);
        if (token === undefined || id === undefined) {
            throw new IdpError('The ID token has no user');
        }
        const { seller, customer, orgAdmin } = this.options.roles;
        const username = text(token['preferred_username']) ?? text(token['displayName']) ?? id;
        const displayName = text(token['displayName']);
        const email = text(token['email']);

        return {
            id,
            username,
            ...(displayName === undefined ? {} : { displayName }),
            ...(email === undefined ? {} : { email }),
            roles: [{ id: seller, name: seller }],
            organizations: [
                {
                    id: this.id,
                    name: this.id,
                    roles: [seller, customer, orgAdmin].map((role) => ({ id: role, name: role }))
                }
            ],
            ...(typeof token['exp'] === 'number' ? { expire: token['exp'] } : {})
        };
    }

    /** A token that somebody presents: accepted only when its signature is checked against the keys of the identity provider. */
    async claimsOf(accessToken: string): Promise<IdentityClaims> {
        if (this.options.verifier === undefined) {
            throw new IdpError('An i4Trust token is only accepted from a login');
        }
        return this.claimsFrom(await this.options.verifier.verify(accessToken));
    }

    refresh(): Promise<IdentityTokens> {
        return Promise.reject(new IdpError('i4Trust tokens are not refreshed'));
    }
}
