import { outboundFetch } from '../../http-client/outbound-fetch';

export type Fetcher = typeof fetch;

/**
 * What the providers call identity providers with: the call is measured and logged under the target `idp` (one name for all of them,
 * since an administrator can add providers at run time), and the id of the request is not sent, as it means nothing to them.
 * A call made with a `Request` object is not followed, since the project never makes one.
 */
export const idpFetch: Fetcher = (input, init) =>
    input instanceof Request ? fetch(input, init) : outboundFetch('idp', input, init, { passRequestId: false });

/** An identity provider answered with an error status, or with something that is not what it should be. */
export class IdpError extends Error {
    constructor(
        message: string,
        readonly status?: number
    ) {
        super(message);
        this.name = 'IdpError';
    }
}

/**
 * One call to an identity provider, answered as JSON. A non-2xx status, a timeout and an unreadable answer all reject; the message
 * carries the status and never the body, which may hold tokens.
 */
export const requestJson = async (fetcher: Fetcher, url: string, init: RequestInit, timeoutMs: number): Promise<Record<string, unknown>> => {
    const response = await fetcher(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) {
        throw new IdpError(`The identity provider answered ${response.status}`, response.status);
    }
    const body: unknown = await response.json().catch(() => undefined);
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        throw new IdpError('The identity provider did not answer a JSON object');
    }
    return body as Record<string, unknown>;
};

/** The tokens of a `refresh_token` grant, as an OAuth2 token endpoint answers them. */
export const tokensOf = (answer: Record<string, unknown>, now: () => number = () => Math.floor(Date.now() / 1000)) => {
    const accessToken = answer['access_token'];
    if (typeof accessToken !== 'string' || accessToken === '') {
        throw new IdpError('The identity provider gave no access token');
    }
    const refreshToken = answer['refresh_token'];
    const lifetime = answer['expires_in'];
    return {
        accessToken,
        ...(typeof refreshToken === 'string' && refreshToken !== '' ? { refreshToken } : {}),
        ...(typeof lifetime === 'number' && lifetime > 0 ? { expire: now() + Math.floor(lifetime) } : {})
    };
};
