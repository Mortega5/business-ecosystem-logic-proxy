import { createPublicKey } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { IdpError, requestJson, idpFetch, type Fetcher } from './idp-http';

export interface JwksOptions {
    /** Where the identity provider publishes its public keys. */
    url: string;
    timeoutMs: number;
    /** When given, the token must be issued by it. */
    issuer?: string;
    /** When given, the token must be meant for it. */
    audience?: string;
    /** How long the keys are kept before they are asked again (ten minutes by default). */
    cacheMs?: number;
    fetcher?: Fetcher;
    now?: () => number;
}

type Claims = Record<string, unknown>;

// Algorithms of public keys only: with a shared secret in the list, a forger signs with the public key as if it were the secret
const ALGORITHMS = ['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512'] as const;
const KEY_ID_RETRY_MS = 30_000;

/** Checks a token against the keys that its identity provider publishes: signature, algorithm, expiry, and issuer and audience if asked. */
export class JwksVerifier {
    private readonly fetcher: Fetcher;
    private readonly now: () => number;
    private keys = new Map<string, string>();
    private fetchedAt = Number.NEGATIVE_INFINITY;
    private loading: Promise<void> | undefined;

    constructor(private readonly options: JwksOptions) {
        this.fetcher = options.fetcher ?? idpFetch;
        this.now = options.now ?? Date.now;
    }

    async verify(token: string): Promise<Claims> {
        const header = this.headerOf(token);
        const key = await this.keyFor(header.kid);
        const decoded = jwt.verify(token, key, {
            algorithms: [header.alg],
            ...(this.options.issuer === undefined ? {} : { issuer: this.options.issuer }),
            ...(this.options.audience === undefined ? {} : { audience: this.options.audience })
        });
        if (typeof decoded !== 'object') {
            throw new IdpError('The token has no claims');
        }
        return decoded as Claims;
    }

    private headerOf(token: string): { alg: (typeof ALGORITHMS)[number]; kid: string | undefined } {
        let header: unknown;
        try {
            header = JSON.parse(Buffer.from(token.split('.')[0] ?? '', 'base64url').toString('utf8'));
        } catch {
            throw new IdpError('The token is not a JWT');
        }
        const { alg, kid } = (typeof header === 'object' && header !== null ? header : {}) as { alg?: unknown; kid?: unknown };
        const algorithm = ALGORITHMS.find((candidate) => candidate === alg);
        if (algorithm === undefined) {
            throw new IdpError('The token is signed with an algorithm that is not accepted');
        }
        return { alg: algorithm, kid: typeof kid === 'string' ? kid : undefined };
    }

    private async keyFor(kid: string | undefined): Promise<string> {
        const cacheMs = this.options.cacheMs ?? 600_000;
        if (this.now() - this.fetchedAt >= cacheMs) {
            await this.load();
        }
        let key = this.find(kid);
        // A key that is not there may be a new one, but a forger can make up ids: it is asked again at most every half minute
        if (key === undefined && this.now() - this.fetchedAt >= KEY_ID_RETRY_MS) {
            await this.load();
            key = this.find(kid);
        }
        if (key === undefined) {
            throw new IdpError('The token is signed with a key that the identity provider does not publish');
        }
        return key;
    }

    private find(kid: string | undefined): string | undefined {
        if (kid !== undefined) {
            return this.keys.get(kid);
        }
        return this.keys.size === 1 ? [...this.keys.values()][0] : undefined;
    }

    // Many tokens that arrive together wait for one request of the keys
    private load(): Promise<void> {
        this.loading ??= this.fetchKeys().finally(() => {
            this.loading = undefined;
        });
        return this.loading;
    }

    private async fetchKeys(): Promise<void> {
        const answer = await requestJson(this.fetcher, this.options.url, { headers: { accept: 'application/json' } }, this.options.timeoutMs);
        const keys = new Map<string, string>();
        for (const entry of Array.isArray(answer['keys']) ? (answer['keys'] as Claims[]) : []) {
            if (entry['use'] !== undefined && entry['use'] !== 'sig') {
                continue;
            }
            try {
                const pem = createPublicKey({ key: entry as never, format: 'jwk' }).export({ type: 'spki', format: 'pem' }).toString();
                keys.set(typeof entry['kid'] === 'string' ? entry['kid'] : `#${keys.size}`, pem);
            } catch {
                // a key that cannot be read is one that signs nothing here
            }
        }
        this.keys = keys;
        this.fetchedAt = this.now();
    }
}
