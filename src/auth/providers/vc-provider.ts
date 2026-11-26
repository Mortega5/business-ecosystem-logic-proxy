import { randomUUID, type KeyObject } from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { IdentityClaims } from '../profile/user-profile';
import type { IdentityProvider, IdentityTokens, LoginOutcome } from './identity-provider';
import { IdpError, requestJson, tokensOf, idpFetch, type Fetcher } from './idp-http';
import { JwksVerifier } from './jwks-verifier';
import { claimsFromCredential, type CredentialPolicy } from './vc-credential';

export interface VcOptions {
    id: string;
    /** What the proxy is to the verifier. */
    clientId: string;
    privateKey: KeyObject;
    signAlgorithm: string;
    /** The address the verifier sends the user, or its answer, back to. */
    callbackUrl: string;
    verifierHost: string;
    verifierTokenPath: string;
    verifierJwksPath: string;
    /** When set, a token has to be issued by it. */
    verifierIssuer?: string;
    policy: CredentialPolicy;
    timeoutMs: number;
    fetcher?: Fetcher;
}

const joinUrl = (host: string, path: string): string =>
    `${host.replace(/\/+$/, '')}${path.startsWith('/') ? path : `/${path}`}`;

/**
 * The login with verifiable credentials. The user shows a credential in a wallet to a verifier, which signs a token that carries it;
 * the proxy is a client of that verifier. The token is checked against the keys the verifier publishes and the credential in it is
 * where the user, the roles and the organisation come from, so what the credential says is as trusted as the verifier is.
 */
export class VcProvider implements IdentityProvider {
    readonly id: string;
    private readonly fetcher: Fetcher;
    private readonly verifier: JwksVerifier;
    private readonly tokenUrl: string;

    constructor(private readonly options: VcOptions) {
        this.id = options.id;
        this.fetcher = options.fetcher ?? idpFetch;
        this.tokenUrl = joinUrl(options.verifierHost, options.verifierTokenPath);
        this.verifier = new JwksVerifier({
            url: joinUrl(options.verifierHost, options.verifierJwksPath),
            timeoutMs: options.timeoutMs,
            ...(options.verifierIssuer === undefined ? {} : { issuer: options.verifierIssuer }),
            fetcher: this.fetcher
        });
    }

    /** The claims of a token that the verifier signed: the signature and the expiry are checked, and the credential is read. */
    async claimsOf(accessToken: string): Promise<IdentityClaims> {
        return claimsFromCredential(await this.verifier.verify(accessToken), this.options.policy);
    }

    /** The payload of a token that the verifier signed, for what is not a login. */
    verify(token: string): Promise<Record<string, unknown>> {
        return this.verifier.verify(token);
    }

    async refresh(refreshToken: string): Promise<IdentityTokens> {
        return this.tokens({ grant_type: 'refresh_token', refresh_token: refreshToken }, true);
    }

    /** What the wallet fetches to know what the proxy asks the user for: signed with the key of the proxy. */
    requestObject(): string {
        const { clientId, verifierHost, callbackUrl } = this.options;
        return this.sign({
            iss: clientId,
            aud: verifierHost,
            response_type: 'code',
            client_id: clientId,
            redirect_uri: callbackUrl,
            scope: 'openid learcredential'
        });
    }

    /**
     * The tokens for the code that the verifier gave. With `authenticated` the proxy proves who it is with a signed assertion, as when the
     * user comes back to the proxy; when the verifier answers behind the user's back it is asked as it has always been, with the code only.
     */
    async exchange(code: string, authenticated: boolean): Promise<IdentityTokens> {
        // As v11 asked: the one that proves who it is does not say where the user came back to, and the other does
        return this.tokens(
            authenticated
                ? { grant_type: 'authorization_code', code }
                : { grant_type: 'authorization_code', code, redirect_uri: this.options.callbackUrl },
            authenticated
        );
    }

    /** The user and their tokens for a code. A token that does not carry a credential is no login. */
    async login(code: string, authenticated: boolean): Promise<LoginOutcome> {
        const tokens = await this.exchange(code, authenticated);
        return { tokens, claims: await this.claimsOf(tokens.accessToken) };
    }

    private async tokens(params: Record<string, string>, authenticated: boolean): Promise<IdentityTokens> {
        const form = new URLSearchParams(params);
        if (authenticated) {
            form.set('client_id', this.options.clientId);
            form.set('client_assertion_type', 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
            form.set('client_assertion', this.clientAssertion());
        }
        const answer = await requestJson(
            this.fetcher,
            this.tokenUrl,
            {
                method: 'POST',
                headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
                body: form
            },
            this.options.timeoutMs
        );
        return tokensOf(answer);
    }

    /** A new proof of who the proxy is, for each use, good for thirty seconds. */
    private clientAssertion(): string {
        const { clientId, verifierHost } = this.options;
        const iat = Math.floor(Date.now() / 1000);
        return this.sign({ iss: clientId, aud: verifierHost, sub: clientId, jti: randomUUID(), iat, exp: iat + 30 });
    }

    private sign(payload: Record<string, unknown>): string {
        const { privateKey, signAlgorithm, clientId } = this.options;
        try {
            return jwt.sign(payload, privateKey, { algorithm: signAlgorithm as jwt.Algorithm, keyid: clientId });
        } catch {
            // The message of the library can name the key
            throw new IdpError('The proxy could not sign for the verifier');
        }
    }
}
