import type { IncomingHttpHeaders } from 'node:http';
import type { AppConfig } from '../config/config.schema';

/** The user as the authentication leaves it in `req.user`; only what the upstreams are told about. */
export interface UpstreamUser {
    id: string;
    userId?: string | null;
    partyId?: string | null;
    userPartyId?: string | null;
    username?: string;
    displayName?: string;
    email?: string;
    roles?: { name: string }[];
    idp?: string;
    issuerDid?: string;
    agreedOnTerms?: boolean;
    accessToken?: string;
}

export type HeaderPolicy = Pick<AppConfig['auth'], 'propagateToken' | 'allowLocalEori' | 'roles'>;

export interface UpstreamHeadersInput {
    client: IncomingHttpHeaders;
    user: UpstreamUser | undefined;
    /** The chain of clients as the HTTP server computed it from its trusted proxies, never the client's own header. */
    forwardedFor: string | undefined;
    policy: HeaderPolicy;
}

// The only headers of the client that reach an upstream. Everything else, identity headers above all, is the
// proxy's to say: a header that is not listed here cannot be used to pose as somebody else.
const FROM_CLIENT = [
    'accept',
    'accept-language',
    'content-type',
    'if-match',
    'if-none-match',
    'if-modified-since',
    'if-unmodified-since',
    'user-agent'
];

// Header values are bytes: a name outside Latin-1 would make the request fail, so it travels percent-encoded
const toHeaderValue = (value: string): string => {
    let text = '';
    let wide = false;
    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        if (code < 0x20 || code === 0x7f) {
            continue;
        }
        wide ||= code > 0xff;
        text += value.charAt(index);
    }
    return wide ? encodeURIComponent(text) : text;
};

const roleList = (user: UpstreamUser, policy: HeaderPolicy): string => {
    const known = Object.values(policy.roles).map((role) => role.toLowerCase());
    return (user.roles ?? [])
        .map((role) => role.name.toLowerCase())
        .filter((name) => known.includes(name))
        .map((name) => `${name},`)
        .join('');
};

const identityHeaders = (user: UpstreamUser, policy: HeaderPolicy): Record<string, string | undefined> => {
    const isOrganization = user.userId === undefined || user.userId === null;
    const displayName = user.displayName === undefined || user.displayName === '' ? user.username : user.displayName;
    const idpId = user.idp === 'local' && user.userId != null && policy.allowLocalEori ? user.displayName : user.idp;
    return {
        'X-Email': user.email,
        'X-Display-Name': displayName,
        'X-Roles': roleList(user, policy),
        'X-Ext-Name': isOrganization ? user.username : '',
        'X-Actor-ID': user.id,
        'X-User-ID': user.userId ?? user.id,
        'X-Party-ID': user.partyId ?? undefined,
        'X-User-Party-ID': user.userPartyId ?? user.partyId ?? undefined,
        'X-IDP-ID': idpId,
        'X-ISSUER-DID': user.issuerDid,
        'X-Terms-Accepted': user.agreedOnTerms === true ? 'True' : undefined
    };
};

/** The headers a request to an upstream carries: a short list from the client, plus what the proxy knows of the user. */
export const buildUpstreamHeaders = ({ client, user, forwardedFor, policy }: UpstreamHeadersInput): Record<string, string> => {
    const headers: Record<string, string> = {};
    const set = (name: string, value: string | string[] | undefined, keepEmpty = false): void => {
        const text = Array.isArray(value) ? value.join(', ') : value;
        if (text !== undefined && (text !== '' || keepEmpty)) {
            headers[name] = toHeaderValue(text);
        }
    };

    for (const name of FROM_CLIENT) {
        set(name, client[name]);
    }
    if (forwardedFor !== undefined) {
        set('X-Forwarded-For', forwardedFor);
    }
    if (user !== undefined) {
        // As the legacy proxy did, an empty X-Roles or X-Ext-Name is still sent
        for (const [name, value] of Object.entries(identityHeaders(user, policy))) {
            set(name, value, true);
        }
        if (policy.propagateToken && user.accessToken !== undefined) {
            set('Authorization', `Bearer ${user.accessToken}`);
        }
    }
    return headers;
};
