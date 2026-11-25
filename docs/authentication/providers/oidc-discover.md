# Provider `oidc-discover` (generic OpenID Connect)

Use it for any identity provider that speaks OpenID Connect and publishes a discovery document
(`/.well-known/openid-configuration`), and for logins where the user presents a verifiable credential through OIDC.

[Back to authentication](../../authentication.md)

> **Status in v12:** the reading of tokens, the refresh and the audience check are ported. The login (authorization code with
> `openid-client`, scopes, nonce) comes with the login routes, and so does the profile of a verifiable credential, which goes
> with [`vc`](vc.md).

## Settings

Set `BAE_LP_OAUTH2_PROVIDER=oidc-discover`:

| v11 variable | v12 key | Required | Meaning |
|---|---|---|---|
| `BAE_LP_OAUTH2_SERVER` | `auth.idp.server` | one of the two | Issuer URL; the discovery document is read from `<issuer>/.well-known/openid-configuration` |
| `BAE_LP_OIDC_DISCOVERY_URI` | `auth.idp.discoveryUrl` | one of the two | The discovery document, when it is not at the issuer. A URL that already has `/.well-known/` is used as it is |
| `BAE_LP_OAUTH2_CLIENT_ID`, `BAE_LP_OAUTH2_CLIENT_SECRET` | `auth.idp.clientId`, `auth.idp.clientSecret` | yes | Credentials of the proxy as a client |
| `BAE_LP_OAUTH2_CALLBACK` | `auth.idp.callbackUrl` | yes | `https://<proxy>/auth/oidc-discover/callback` |
| `BAE_LP_OIDC_TOKEN_AUTH_METHOD` | `auth.idp.tokenAuthMethod` | no, `client_secret_basic` | How the client authenticates at the token endpoint: `client_secret_basic` or `client_secret_post` |
| `BAE_LP_OIDC_SCOPES` | `auth.idp.scopes` | no, `openid` | What is asked at the login; it has to include `openid`, because the user is read from the ID token |
| | `auth.idp.audience` | no | When set, a token presented without a login must be meant for it (its `aud`). When not set, the audience is not checked |
| `BAE_LP_OAUTH2_DEFAULT_ROLE` | `auth.idp.defaultRole` | no | Role of a user whose token has no roles; the seller role if not set |
| `BAE_LP_OIDC_SCOPES`, `BAE_LP_OAUTH2_NONCE` | (with the login) | no | Scopes asked (`openid` by default) and whether a nonce is sent |

```
BAE_LP_OAUTH2_PROVIDER=oidc-discover
BAE_LP_OAUTH2_SERVER=https://idp.example.org/realms/dome
BAE_LP_OAUTH2_CLIENT_ID=bae
BAE_LP_OAUTH2_CLIENT_SECRET=<client secret>
BAE_LP_OAUTH2_CALLBACK=https://bae.example.org/auth/oidc-discover/callback
BAE_AUTH__IDP__AUDIENCE=bae
```

## The audience

An identity provider that serves several applications gives each its own tokens, and a token says in `aud` which one it is for. If
the audience is not set, a token that the same issuer gave to **another** client is accepted here too. Set it to the value the
tokens meant for the proxy carry (usually its client id) to refuse the others. With it set, a token with no `aud`, or with
another one, is refused.

## How the user is read

- **Login**: the claims of the ID token of the token endpoint.
- **Bearer without a login**: the access token is a JWT and is checked against the keys the issuer publishes (`jwks_uri` of the
  discovery document): signature (RSA and EC algorithms only), expiry, issuer, and audience when it is set. The keys and the
  discovery document are kept for a while and asked again when they are old.

From the claims: `id` is `sub` (or `preferred_username`), `username` is `preferred_username` (or `username`, or the id),
`displayName` is `name`, `preferred_username` or `username`, `email` is `email`. `roles` (names or `{ id, name }`) and
`organizations` (`{ id, name, roles }`) are taken from the claims of the same names when they are there. With no roles the user
is given `defaultRole`, or the seller role. The expiry is the `exp` of the token.

## Refresh

`refresh_token` grant at the `token_endpoint` of the discovery document.
