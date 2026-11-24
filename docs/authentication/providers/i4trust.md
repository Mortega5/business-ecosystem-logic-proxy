# Provider `i4trust` (iSHARE)

Use it to log in users of an iSHARE / i4Trust identity provider. It is also the provider of every identity provider that an
administrator adds at run time with the `/IDP` routes.

[Back to authentication](../../authentication.md)

> **Status in v12:** the way the user is read is ported; the login (signed request, `/IDP` routes) comes with the login routes.

## Settings

Main provider (`BAE_LP_OAUTH2_PROVIDER=i4trust`):

| v11 variable | v12 key | Meaning |
|---|---|---|
| `BAE_LP_OAUTH2_SERVER` | `auth.idp.server` | Base URL of the identity provider |
| `BAE_LP_OAUTH2_CLIENT_ID` | `auth.idp.clientId` | EORI of the proxy as a client |
| `BAE_LP_OAUTH2_CALLBACK` | `auth.idp.callbackUrl` | `https://<proxy>/auth/i4trust/callback` |
| `BAE_LP_OIDC_TOKEN_KEY`, `BAE_LP_OIDC_TOKEN_CRT` | | Paths of the private key and of the certificate chain with which the proxy signs its requests |
| | `auth.idp.jwksUrl` | Optional. Keys of the identity provider, to accept tokens that are presented without a login (see below) |

Every identity provider added with `/IDP` (only with `BAE_LP_EXT_LOGIN=true`) has `idpId` (its EORI), `server`, `clientID`,
`callbackURL` and the key and the certificate of the proxy. Its login is `/login/<idpId>` and its callback
`/auth/<idpId>/callback`.

## Login

The proxy does not send a plain authorization request. It builds a JWT signed with its key (RS256, the certificate chain in the
`x5c` header, 30 seconds of life, audience the `idpId`), posts it to `<server>/oauth2/authorize` and follows the `Location` the
identity provider answers. When the code comes back, it is exchanged at `<server>/oauth2/token` with that same signed JWT as the
`client_assertion`. Scope: `jwt openid iSHARE email profile`.

## How the user is read

From the ID token that the token endpoint gives with the code. It comes straight from the identity provider over TLS, and it is
the only place an identity is taken from. `id` is `sub`, `username` is `preferred_username` (or the display name, or the id),
`displayName` and `email` come from the token, and so does the expiry.

Every user has the seller role and is the administrator of one organization, named after the `idpId`, with the seller,
customer and organization administrator roles.

## Bearer without a login

A token that is presented without going through a login is accepted only if `auth.idp.jwksUrl` is set: its signature is then
checked against the published keys (RSA or EC algorithms only, and its expiry). Without it the token is refused.

## Refresh

None: the identity provider does not give a usable refresh token. When the token expires the user logs in again.
