import { describe, expect, it } from 'vitest';
import { buildUpstreamHeaders, type HeaderPolicy, type UpstreamUser } from './upstream-headers';

const policy: HeaderPolicy = {
    propagateToken: true,
    allowLocalEori: false,
    roles: { admin: 'admin', customer: 'Buyer', seller: 'Seller', orgAdmin: 'orgAdmin' }
};

const ana: UpstreamUser = {
    id: 'u-ana',
    userId: null,
    partyId: 'p-ana',
    username: 'ana',
    displayName: 'Ana Pérez',
    email: 'ana@example.org',
    roles: [{ name: 'Seller' }, { name: 'Buyer' }, { name: 'something-else' }],
    idp: 'keycloak',
    accessToken: 'token-1'
};

const forged = {
    'x-email': 'root@example.org',
    'x-roles': 'admin,',
    'x-actor-id': 'u-root',
    'x-user-id': 'u-root',
    'x-party-id': 'p-root',
    'x-idp-id': 'trusted-idp',
    'x-issuer-did': 'did:web:evil',
    'x-terms-accepted': 'True',
    authorization: 'Bearer stolen',
    cookie: 'connect.sid=s%3Asession',
    host: 'internal',
    'x-forwarded-for': '10.0.0.1',
    'x-organization': 'org-1',
    connection: 'keep-alive'
};

describe('buildUpstreamHeaders', () => {
    it('sends only what the proxy knows of the user, whatever the client claims', () => {
        const headers = buildUpstreamHeaders({ client: forged, user: ana, forwardedFor: '203.0.113.9', policy });

        expect(headers).toEqual({
            'X-Email': 'ana@example.org',
            'X-Display-Name': 'Ana Pérez',
            'X-Roles': 'seller,buyer,',
            'X-Ext-Name': 'ana',
            'X-Actor-ID': 'u-ana',
            'X-User-ID': 'u-ana',
            'X-Party-ID': 'p-ana',
            'X-User-Party-ID': 'p-ana',
            'X-IDP-ID': 'keycloak',
            'X-Forwarded-For': '203.0.113.9',
            Authorization: 'Bearer token-1'
        });
    });

    it('sends no identity header at all when nobody is logged in', () => {
        const headers = buildUpstreamHeaders({ client: forged, user: undefined, forwardedFor: undefined, policy });
        expect(headers).toEqual({});
    });

    it('never takes the client chain of addresses, only the one it is given', () => {
        const headers = buildUpstreamHeaders({
            client: { 'x-forwarded-for': '1.2.3.4' },
            user: undefined,
            forwardedFor: '203.0.113.9',
            policy
        });
        expect(headers['X-Forwarded-For']).toBe('203.0.113.9');
    });

    it('forwards the few client headers that describe the request', () => {
        const headers = buildUpstreamHeaders({
            client: { accept: 'application/json', 'content-type': 'application/json', 'if-none-match': '"v1"', 'x-custom': 'no' },
            user: undefined,
            forwardedFor: undefined,
            policy
        });
        expect(headers).toEqual({ accept: 'application/json', 'content-type': 'application/json', 'if-none-match': '"v1"' });
    });

    it('acts for an organisation: the user is the organisation and the person is the individual', () => {
        const organisation: UpstreamUser = {
            ...ana,
            id: 'org-1',
            userId: 'u-ana',
            userPartyId: 'p-ana',
            partyId: 'p-org',
            username: 'acme',
            displayName: 'ACME',
            roles: [{ name: 'orgAdmin' }]
        };
        const headers = buildUpstreamHeaders({ client: {}, user: organisation, forwardedFor: undefined, policy });
        expect(headers).toMatchObject({
            'X-Actor-ID': 'org-1',
            'X-User-ID': 'u-ana',
            'X-Party-ID': 'p-org',
            'X-User-Party-ID': 'p-ana',
            'X-Ext-Name': '',
            'X-Roles': 'orgadmin,'
        });
    });

    it('names the IdP after the display name for local users when it is allowed', () => {
        const local: UpstreamUser = { ...ana, idp: 'local', userId: 'u-ana', displayName: 'ACME Ltd' };
        const allowed = buildUpstreamHeaders({ client: {}, user: local, forwardedFor: undefined, policy: { ...policy, allowLocalEori: true } });
        const refused = buildUpstreamHeaders({ client: {}, user: local, forwardedFor: undefined, policy });
        expect(allowed['X-IDP-ID']).toBe('ACME Ltd');
        expect(refused['X-IDP-ID']).toBe('local');
    });

    it('adds the issuer and the accepted terms only when the user has them', () => {
        const headers = buildUpstreamHeaders({
            client: {},
            user: { ...ana, issuerDid: 'did:web:issuer.example', agreedOnTerms: true },
            forwardedFor: undefined,
            policy
        });
        expect(headers).toMatchObject({ 'X-ISSUER-DID': 'did:web:issuer.example', 'X-Terms-Accepted': 'True' });
    });

    it('does not send the token when propagation is off', () => {
        const headers = buildUpstreamHeaders({ client: {}, user: ana, forwardedFor: undefined, policy: { ...policy, propagateToken: false } });
        expect(headers).not.toHaveProperty('Authorization');
    });

    it('falls back to the username when there is no display name', () => {
        const headers = buildUpstreamHeaders({ client: {}, user: { ...ana, displayName: '' }, forwardedFor: undefined, policy });
        expect(headers['X-Display-Name']).toBe('ana');
    });

    it('keeps a value from breaking the request: control characters go, and names outside Latin-1 are encoded', () => {
        const headers = buildUpstreamHeaders({
            client: {},
            user: { ...ana, displayName: 'Ana\r\nX-Roles: admin', email: '\u0141ukasz@example.org' },
            forwardedFor: undefined,
            policy
        });
        expect(headers['X-Display-Name']).toBe('AnaX-Roles: admin');
        expect(headers['X-Email']).toBe('%C5%81ukasz%40example.org');
    });
});
