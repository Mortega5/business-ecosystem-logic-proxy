# Authentication

How a user is identified by the proxy: the login strategies, what each one needs, how the profile is built and how a
request is authenticated. It describes the behaviour of the v11 application (`lib/auth.js`, `lib/strategies/`,
`server.js`), which is the contract the NestJS version has to keep.

## The two ways in

| Way | Used by | What the proxy keeps |
|---|---|---|
| Redirect login (`/login`, `/login/:idp`) | The portal | A cookie session, and the profile in the token cache |
| `Authorization: Bearer <token>` (or `X-Auth-Token`) | The portal after `/logintoken`, and any API client | Only the token cache |

1. The portal sends the browser to `/login`. The proxy redirects to the identity provider (IdP) with a random `state`
   that it stores in the session together with the path the user came from.
2. The IdP calls back `/auth/<provider>/callback?code=…&state=…`. The strategy exchanges the code for tokens, builds the
   profile, and the proxy creates the party in TMForum if it does not exist (see [Profile](#profile)).
3. The portal asks `/logintoken` and receives the profile, access token included. From then on it sends the token as a
   bearer, with `X-Organization` when the user acts for an organization.

## Which IdP is `local`

`oauth2.provider` (variable `BAE_LP_OAUTH2_PROVIDER`) chooses the strategy of the main IdP. When SIOP is enabled
(`BAE_LP_SIOP_ENABLED=true`) the main IdP is `vc` instead and the `oauth2` settings are not used for the login.

The main IdP is registered under the name `local`. It is the one that validates a bearer token the proxy has not seen
before (see [Bearer without a login](#bearer-without-a-login)).

Other IdPs are added at run time when `BAE_LP_EXT_LOGIN=true`: they are stored in MongoDB, administered with the
`/IDP` routes and always use the `i4trust` strategy (login at `/login/<idpId>`, callback at `/auth/<idpId>/callback`).

## Common settings (`BAE_LP_OAUTH2_*`)

| Variable | Meaning |
|---|---|
| `BAE_LP_OAUTH2_PROVIDER` | `fiware`, `keycloak`, `github`, `i4trust`, `oidc-discover` or `aimarket` |
| `BAE_LP_OAUTH2_SERVER` | Base URL of the IdP (or the discovery URL, for `oidc-discover`) |
| `BAE_LP_OAUTH2_CLIENT_ID`, `BAE_LP_OAUTH2_CLIENT_SECRET` | Credentials of the proxy as a client of the IdP |
| `BAE_LP_OAUTH2_CALLBACK` | Absolute URL the IdP calls back, `https://<proxy>/auth/<provider>/callback` |
| `BAE_LP_OAUTH2_DEFAULT_ROLE` | Role given to a user that arrives without roles (`fiware`, `aimarket`, `oidc-discover`) |
| `BAE_LP_OAUTH2_NONCE` | Adds an OIDC nonce (`oidc-discover`) |
| `BAE_LP_OAUTH2_ADMIN_ROLE`, `_SELLER_ROLE`, `_CUSTOMER_ROLE`, `_ORG_ADMIN_ROLE`, `_ORG_CERTIFIER_ROLE` | Names of the roles of the platform, matched against the roles of the profile |
| `BAE_LP_EXTERNAL_PORTAL` | If set, the callback redirects to `<portal>/dashboard?token=<accessToken>` instead of `/dashboard?token=local` |

## Strategies

### `fiware` (FIWARE Keyrock / IdM)

OAuth2 with the `passport-fiware-oauth` library.

| Variable | Use |
|---|---|
| `BAE_LP_OAUTH2_SERVER`, `_CLIENT_ID`, `_CLIENT_SECRET`, `_CALLBACK` | As above |
| `BAE_LP_OIDC_ENABLED` | `true`: asks `jwt,openid` and signs with `BAE_LP_OIDC_KEY`. `false`: asks `all_info` |
| `BAE_LP_OIDC_KEY` | Key of the IdM for the OIDC mode |

Profile: `username` and `displayName` from the IdM answer (the display name falls back to the username); `roles` and
`organizations` come as the IdM returns them; `BAE_LP_OAUTH2_DEFAULT_ROLE` is applied when there are no roles. The
expiry is the `exp` of the token if there is one. It refreshes with the `refresh_token` grant.

In v12 the two modes work like this. With `BAE_LP_OIDC_ENABLED=true` (the default) the access token is a JWT that is checked
here with `BAE_LP_OIDC_KEY`, only with the HMAC algorithms and without asking the IdM; the key is required, **there is no
default key** (v11 has a fixed one for development, which a deployment that forgets the variable would inherit). With `BAE_LP_OIDC_ENABLED=false` the IdM is asked at `<server>/user?access_token=<token>`; the token goes in the URL
because the IdM takes it there, so the access log of the IdM holds it. The refresh sends the client credentials both in the
`Authorization: Basic` header and in the body, as v11 did, and takes the expiry from `expires_in`. A user the IdM gives no
`username` is named after the display name, or the id.

### `keycloak`

OAuth2/OIDC with `passport-keycloak-oauth2-oidc`.

| Variable | Use |
|---|---|
| `BAE_LP_OAUTH2_SERVER` | Base URL of Keycloak (a trailing `/` is added) |
| `BAE_LP_OIDC_REALM` | Realm |
| `BAE_LP_OAUTH2_CLIENT_ID`, `_CLIENT_SECRET`, `_CALLBACK` | Confidential client of the realm |

Profile: the roles are the client roles of `resource_access[<clientID>]` of the access token. Each group of the token
is an organization of the user; its name is read from TMForum when the organization exists, and it gets the seller,
customer and organization administrator roles. Scope: `profile`.

In v12 the user is asked to `<server>/realms/<realm>/protocol/openid-connect/userinfo` with the access token, and the roles and
groups are read from that token (which Keycloak has just accepted). The expiry is the `exp` of the token. It refreshes with the
`refresh_token` grant against the token endpoint of the realm, authenticating with the client id and secret. The settings are
`BAE_LP_OAUTH2_PROVIDER`, `_SERVER`, `_CLIENT_ID`, `_CLIENT_SECRET`, `_CALLBACK` and `BAE_LP_OIDC_REALM`, all required.

### `github`

OAuth2 with `passport-github`. Needs `BAE_LP_OAUTH2_CLIENT_ID`, `_CLIENT_SECRET` and `_CALLBACK`; scope `user:email`.

Profile: no organizations, and a single role, the seller one. It has no refresh: when the token expires the user logs
in again.

### `i4trust`

OAuth2/OIDC with `passport-i4trust`, authenticating the proxy to the IdP with a signed token (iSHARE).

| Variable | Use |
|---|---|
| `BAE_LP_OAUTH2_SERVER`, `_CLIENT_ID`, `_CALLBACK` | As above |
| `BAE_LP_OIDC_TOKEN_KEY`, `BAE_LP_OIDC_TOKEN_CRT` | Private key and certificate used to sign the client assertion |

It is also the strategy of every IdP created through `/IDP`, with the fields `idpId`, `server`, `clientID`, `callbackURL`
and the key and certificate of the proxy.

Profile: `id` from `sub`, `email` from the token, one organization named after the `idpId` with the seller, customer
and organization administrator roles, and the seller role for the user. Scope: `jwt openid iSHARE email profile`.

### `oidc-discover`

Generic OpenID Connect with `openid-client`. The IdP endpoints are discovered.

| Variable | Use |
|---|---|
| `BAE_LP_OAUTH2_SERVER` | Issuer URL, used for discovery |
| `BAE_LP_OIDC_DISCOVERY_URI` | Discovery URL when it is not the issuer URL |
| `BAE_LP_OIDC_SCOPES` | Scopes asked (`openid` by default) |
| `BAE_LP_OIDC_TOKEN_AUTH_METHOD` | How the client authenticates at the token endpoint (`client_secret_basic` by default) |
| `BAE_LP_OAUTH2_NONCE` | Sends a nonce |

Profile: `id` from `sub`, display name from `name` or `preferred_username`. If the claims are a verifiable credential,
the profile is the one of the credential (the one `vc` builds). Without roles it uses `BAE_LP_OAUTH2_DEFAULT_ROLE`, or
the seller role. The access token is verified against the keys (JWKS) of the issuer, and it refreshes with the
refresh token.

### `aimarket`

The same OAuth2 library as `fiware`, for the AI Market IdP. The settings are the ones of `fiware`
(`BAE_LP_OIDC_ENABLED`, `BAE_LP_OIDC_KEY`, `BAE_LP_OAUTH2_DEFAULT_ROLE`); scope `jwt` in OIDC mode, `all_info` if not.

Profile: as `fiware`, plus `given_name`, `family_name` and the `extra.aimData.user` block (first and last name, gender,
academic title, language, picture) that the AI Market sends.

### `vc` (SIOP / verifiable credentials)

Login with a wallet, not a password. It is part of the DOME integration and is described apart when it is migrated. It
is enabled with `BAE_LP_SIOP_ENABLED=true`. The settings are: `BAE_LP_SIOP_CLIENT_ID`, `BAE_LP_SIOP_PRIVATE_KEY` or
`BAE_LP_SIOP_PRIVATE_KEY_PEM`, `BAE_LP_SIOP_CALLBACK_PATH`, `BAE_LP_SIOP_REQUEST_URI`, `BAE_LP_SIOP_VERIFIER_HOST` and its
paths (`_QRCODE_PATH`, `_TOKEN_PATH`, `_JWKS_PATH`), `BAE_LP_SIOP_ALLOWED_ROLES`, `BAE_LP_SIOP_OPERATORS`,
`BAE_LP_SIOP_IS_REDIRECTION` (redirect flow or polling flow with `/poll`) and `BAE_LP_SIO_SIGN_ALGORITHM` (`ES256` by
default).

## Profile

Every strategy ends in the same shape, which the rest of the proxy reads:

| Field | Meaning |
|---|---|
| `id`, `username`, `displayName`, `email` | Identity in the IdP |
| `roles` | `[{ id, name }]`, matched against the role names of the platform |
| `organizations` | `[{ id, name, roles }]`, the organizations the user can act for |
| `accessToken`, `refreshToken`, `expire` | Tokens and expiry (unix seconds) |
| `idp` | The IdP the user came from (`local` or the `idpId`) |
| `partyId` | Id of the individual in TMForum, and `partyId` of each organization |

On the first use of a token the proxy looks the individual up by `externalReference.name=<id>` and creates it if it is
missing; the same is done for each organization, and the individual is updated with the organizations and the role of
the user in each. When the IdP gives no expiry it is set to 30 minutes.

## Token cache

Profiles are cached by access token: at most 50 entries and 2 hours in v11 (both settings in v12, see below). A cached profile is used
while it still has more than 5 seconds of life; after that the proxy refreshes it.

A refresh token can be used only once, so concurrent requests of a user whose token is expiring share one refresh
(the first one calls the IdP and the others wait for its answer).

### Where the cache lives (v12)

| Variable | Meaning |
|---|---|
| `BAE_AUTH__STORE__TYPE` | `memory` (default, one process, as in v11) or `mongo` (collection `auth_cache`, shared by every instance) |
| `BAE_AUTH__REPLACED_TOKEN_GRACE_MS` | After a refresh, how long the token that was replaced still answers with the renewed profile, for the requests that were already on their way with it (30000 by default) |
| `BAE_AUTH__IDP_TIMEOUT_MS` | How long a call to the identity provider (user info, refresh) may take (10000) |
| `BAE_AUTH__PROFILE_TTL_MS` | How long a profile is kept so that its token can be refreshed after it ends (7200000, 2 h). It is also how long a token revoked at the identity provider keeps working, since the provider is not asked while the profile is kept |
| `BAE_AUTH__REFRESH_MARGIN_SECONDS` | A token with this many seconds left or fewer is refreshed (5) |
| `BAE_AUTH__DEFAULT_TOKEN_LIFETIME_SECONDS` | Lifetime given to a token whose provider does not say when it ends (1800) |
| `BAE_AUTH__STORE__MEMORY_MAX_ENTRIES` | Entries kept in memory before the oldest goes (1000 by default) |
| `BAE_AUTH__STORE__ENCRYPTION_KEY` | Required with `mongo`: a random string of 32 characters or more. Profiles hold refresh tokens, so they are stored sealed (AES-256-GCM) and under the hash of the key. Changing it makes the stored entries misses |

## Bearer without a login

When a request arrives with a token that is not in the cache (an API client that never went through the portal), the
proxy asks the `local` IdP for the profile with that token (user info for `fiware`, `keycloak`, `github` and
`i4trust`; signature check against the keys of the issuer for `oidc-discover`), builds the party and caches it with the
expiry of the token. There is no refresh token, so once it expires the client has to send a new one. A token for any
other IdP is accepted only if its owner logged in through the portal.

## Acting for an organization

`X-Organization: <id>` makes the request run as that organization, if it is one of the user's. Otherwise the answer is
401. The request then carries the organization's roles and party id, and the id of the user as `userId`.

## Routes

| Route | Meaning |
|---|---|
| `/login`, `/login/:idpId` | Starts the redirect login |
| `/auth/:provider/callback` | Callback of the IdP |
| `/logOut` | Destroys the session and redirects to `/` |
| `/logintoken` | The profile of the logged user |
| `/IDP`, `/IDP/:idpId` | CRUD of the external IdPs (only with `BAE_LP_EXT_LOGIN=true`) |
