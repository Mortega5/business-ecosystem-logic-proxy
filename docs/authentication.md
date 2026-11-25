# Authentication

How a user is identified by the proxy: the two ways in, which identity provider (IdP) is the main one, how the profile is built
and kept, and how a request is authenticated. What each IdP needs is in its own page, linked below.

## Choose your identity provider

| If your users are in… | Use | Page |
|---|---|---|
| A FIWARE identity manager (Keyrock) | `fiware` | [fiware](authentication/providers/fiware.md) |
| The AI Market | `aimarket` | [aimarket](authentication/providers/aimarket.md) |
| A Keycloak realm | `keycloak` | [keycloak](authentication/providers/keycloak.md) |
| GitHub accounts (a demo, a quick start) | `github` | [github](authentication/providers/github.md) |
| Any other OpenID Connect provider (Auth0, Azure AD, ...) | `oidc-discover` | [oidc-discover](authentication/providers/oidc-discover.md) |
| An iSHARE / i4Trust identity provider | `i4trust` | [i4trust](authentication/providers/i4trust.md) |
| Wallets with verifiable credentials (DOME) | `vc` | [vc](authentication/providers/vc.md) |

The provider is chosen with `BAE_LP_OAUTH2_PROVIDER` (`auth.idp.provider`); `fiware` is the default. With
`BAE_LP_SIOP_ENABLED=true` the main provider is `vc` instead.

The main provider is registered under the name `local`. It is the one that validates a bearer token the proxy has not seen
before (see [Bearer without a login](#bearer-without-a-login)). Other providers are added at run time when
`BAE_LP_EXT_LOGIN=true`: they are stored in MongoDB, administered with the `/IDP` routes and always use the
[i4trust](authentication/providers/i4trust.md) strategy (login at `/login/<idpId>`, callback at `/auth/<idpId>/callback`).

## The two ways in

| Way | Used by | What the proxy keeps |
|---|---|---|
| Redirect login (`/login`, `/login/:idp`) | The portal | A cookie session, and the profile in the token cache |
| `Authorization: Bearer <token>` (or `X-Auth-Token`) | The portal after `/logintoken`, and any API client | Only the token cache |

1. The portal sends the browser to `/login`. The proxy redirects to the identity provider with a random `state` that it stores
   in the session together with the path the user came from.
2. The identity provider calls back `/auth/<provider>/callback?code=...&state=...`. The proxy exchanges the code for tokens,
   builds the profile, and creates the party in TMForum if it does not exist (see [Profile](#profile)).
3. The portal asks `/logintoken` and receives the profile, access token included. From then on it sends the token as a
   bearer, with `X-Organization` when the user acts for an organization.

## Settings of every provider

Each provider page says which of these it needs. The v11 variable is still read; the v12 key can also be set as
`BAE_AUTH__IDP__<KEY>` (for example `BAE_AUTH__IDP__CLIENT_ID`).

| v11 variable | v12 key | Meaning |
|---|---|---|
| `BAE_LP_OAUTH2_PROVIDER` | `auth.idp.provider` | `fiware`, `keycloak`, `github`, `i4trust`, `oidc-discover` or `aimarket` |
| `BAE_LP_OAUTH2_SERVER` | `auth.idp.server` | Base URL of the provider (the issuer, for `oidc-discover`) |
| `BAE_LP_OAUTH2_CLIENT_ID`, `BAE_LP_OAUTH2_CLIENT_SECRET` | `auth.idp.clientId`, `auth.idp.clientSecret` | Credentials of the proxy as a client of the provider |
| `BAE_LP_OAUTH2_CALLBACK` | `auth.idp.callbackUrl` | Absolute URL the provider calls back, `https://<proxy>/auth/<provider>/callback` |
| `BAE_LP_OIDC_REALM` | `auth.idp.realm` | Realm (`keycloak`) |
| `BAE_LP_OIDC_ENABLED`, `BAE_LP_OIDC_KEY` | `auth.idp.oidcEnabled`, `auth.idp.oidcKey` | JWT mode and its key (`fiware`, `aimarket`) |
| `BAE_LP_OAUTH2_DEFAULT_ROLE` | `auth.idp.defaultRole` | Role given to a user that arrives without roles |
| | `auth.idp.jwksUrl` | Public keys of the provider, to check tokens presented without a login (`i4trust`) |
| `BAE_LP_OIDC_DISCOVERY_URI`, `BAE_LP_OIDC_TOKEN_AUTH_METHOD` | `auth.idp.discoveryUrl`, `auth.idp.tokenAuthMethod` | Discovery document and client authentication (`oidc-discover`) |
| | `auth.idp.audience` | Audience that a token presented without a login must have (`oidc-discover`); not checked when not set |
| `BAE_LP_OAUTH2_ADMIN_ROLE`, `_SELLER_ROLE`, `_CUSTOMER_ROLE`, `_ORG_ADMIN_ROLE`, `_ORG_CERTIFIER_ROLE` | `auth.roles.*` | Names of the roles of the platform, matched against the roles of the profile |
| `BAE_LP_EXTERNAL_PORTAL` | | If set, the callback redirects to `<portal>/dashboard?token=<accessToken>` instead of `/dashboard?token=local` |

At start-up the main provider refuses to be built, and says which setting is missing, when one it needs is not set.

## Profile

Every provider ends in the same shape, which the rest of the proxy reads:

| Field | Meaning |
|---|---|
| `id`, `username`, `displayName`, `email` | Identity in the provider |
| `roles` | `[{ id, name }]`, matched against the role names of the platform |
| `organizations` | `[{ id, name, roles }]`, the organizations the user can act for |
| `accessToken`, `refreshToken`, `expire` | Tokens and expiry (unix seconds) |
| `idp` | The provider the user came from (`local` or the `idpId`) |
| `partyId` | Id of the individual in TMForum, and `partyId` of each organization |

On the first use of a token the proxy looks the individual up by `externalReference.name=<id>` and creates it if it is missing;
the same is done for each organization, and the individual is told the role of the person in each. Two requests of a person who
is not known yet share this work, so the same person is not created twice by one process. When the provider gives no expiry it
is set to 30 minutes.

## Token cache

Profiles are cached by access token. A cached profile is used while it still has more than a few seconds of life; after that the
proxy refreshes it. A refresh token can be used only once, so concurrent requests of a user whose token is expiring share one
refresh (the first calls the provider and the others wait for its answer). After a refresh, the token that was replaced keeps
answering with the renewed profile for a short time, for the requests that were already on their way with it.

| Variable | Meaning |
|---|---|
| `BAE_AUTH__STORE__TYPE` | `memory` (default, one process, as in v11) or `mongo` (collection `auth_cache`, shared by every instance) |
| `BAE_AUTH__STORE__MEMORY_MAX_ENTRIES` | Entries kept in memory before the oldest goes (1000 by default; 50 in v11) |
| `BAE_AUTH__STORE__ENCRYPTION_KEY` | Required with `mongo`: a random string of 32 characters or more. Profiles hold refresh tokens, so they are stored sealed (AES-256-GCM) and under the hash of the key. Changing it makes the stored entries misses |
| `BAE_LP_EXTERNAL_PORTAL` | Address of a portal of another site (`auth.externalPortal`). After a login with the main provider the user is sent to `<portal>/dashboard?token=<access token>`, as in v11; without it, to `/dashboard?token=local` |
| `BAE_AUTH__SESSION__SECRET` | Signs the session cookie: a random string of 32 characters or more, with no default. Required once the login is served by the proxy |
| `BAE_AUTH__SESSION__MAX_AGE_MS` | How long a session lasts since its last request (24 hours by default) |
| `BAE_AUTH__SESSION__COOKIE_SECURE` | `auto` (default: Secure when the request came over HTTPS), `true` or `false` |
| `BAE_AUTH__SESSION__COOKIE_SAME_SITE` | `lax` (default) or `strict`. The cookie is always `HttpOnly` |
| `BAE_AUTH__PROFILE_TTL_MS` | How long a profile is kept so that its token can be refreshed after it ends (7200000, 2 h). It is also how long a token revoked at the provider keeps working, since the provider is not asked while the profile is kept |
| `BAE_AUTH__REFRESH_MARGIN_SECONDS` | A token with this many seconds left or fewer is refreshed (5) |
| `BAE_AUTH__DEFAULT_TOKEN_LIFETIME_SECONDS` | Lifetime given to a token whose provider does not say when it ends (1800) |
| `BAE_AUTH__REPLACED_TOKEN_GRACE_MS` | How long the token that was replaced by a refresh still answers with the renewed profile (30000) |
| `BAE_AUTH__IDP_TIMEOUT_MS` | How long a call to the provider (user info, refresh, keys) may take (10000) |

## Bearer without a login

When a request arrives with a token that is not in the cache (an API client that never went through the portal), the proxy asks
the `local` provider for the profile with that token, builds the party and caches it with the expiry of the token. How the
provider checks it is in its page (user info call, signature check, or not accepted). There is no refresh token, so once it
expires the client has to send a new one. A token for any other provider is accepted only if its owner logged in through the
portal.

## Acting for an organization

`X-Organization: <id>` makes the request run as that organization, if it is one of the user's. Otherwise the answer is 401. The
request then carries the organization's roles and party id, and the id of the user as `userId`.

## Routes

| Route | Meaning |
|---|---|
| `/login`, `/login/:idpId` | Starts the redirect login |
| `/auth/:provider/callback` | Callback of the provider |
| `/logOut` | Destroys the session and redirects to `/` |
| `/logintoken` | The profile of the logged user |
| `/IDP`, `/IDP/:idpId` | CRUD of the external providers (only with `BAE_LP_EXT_LOGIN=true`) |
