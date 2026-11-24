# Provider `oidc-discover` (generic OpenID Connect)

Use it for any identity provider that speaks OpenID Connect and publishes a discovery document (`/.well-known/openid-configuration`),
and for logins where the user presents a verifiable credential through OIDC.

[Back to authentication](../../authentication.md)

> **Status in v12:** not ported yet. This page describes the behaviour of v11, which the port keeps unless it says otherwise.

## Settings

Set `BAE_LP_OAUTH2_PROVIDER=oidc-discover`:

| Variable | Meaning |
|---|---|
| `BAE_LP_OAUTH2_SERVER` | Issuer URL; the discovery document is read from it |
| `BAE_LP_OIDC_DISCOVERY_URI` | Discovery URL, when it is not the issuer URL |
| `BAE_LP_OAUTH2_CLIENT_ID`, `BAE_LP_OAUTH2_CLIENT_SECRET` | Credentials of the proxy as a client |
| `BAE_LP_OAUTH2_CALLBACK` | `https://<proxy>/auth/oidc-discover/callback` |
| `BAE_LP_OIDC_SCOPES` | Scopes asked (`openid` by default) |
| `BAE_LP_OIDC_TOKEN_AUTH_METHOD` | How the client authenticates at the token endpoint (`client_secret_basic` by default) |
| `BAE_LP_OAUTH2_NONCE` | `true` sends an OIDC nonce |
| `BAE_LP_OAUTH2_DEFAULT_ROLE` | Role of a user that arrives without roles (the seller role if not set) |

## How the user is read

- **Login**: the claims of the ID token of the token endpoint.
- **Bearer without a login**: the access token is a JWT and is checked against the keys the issuer publishes (`jwks_uri`): its
  signature, its expiry and its issuer. v11 does **not** check the audience, so a token that the same issuer gave to another
  client is accepted.

From the claims: `id` is `sub` (or `preferred_username`), `displayName` is `name`, `preferred_username` or `username`, and
`username` is `preferred_username`. `roles` and `organizations` are taken from the claims of the same names when they are there;
with no roles the user is given `BAE_LP_OAUTH2_DEFAULT_ROLE`, or the seller role. When the claims are a verifiable credential, the
profile is the one the credential gives (the one [`vc`](vc.md) builds).

## Refresh

`refresh_token` grant at the token endpoint of the issuer.
