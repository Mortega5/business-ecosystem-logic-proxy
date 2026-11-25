# Provider `fiware` (FIWARE Keyrock identity manager)

Use it when users are registered in a FIWARE identity manager (Keyrock). It is the default provider.

[Back to authentication](../../authentication.md)

## Settings

Set `BAE_LP_OAUTH2_PROVIDER=fiware` and:

| v11 variable | v12 key | Required | Meaning |
|---|---|---|---|
| `BAE_LP_OAUTH2_SERVER` | `auth.idp.server` | yes | Base URL of the identity manager |
| `BAE_LP_OAUTH2_CLIENT_ID` | `auth.idp.clientId` | yes | Id of the application registered in the identity manager |
| `BAE_LP_OAUTH2_CLIENT_SECRET` | `auth.idp.clientSecret` | yes | Secret of that application |
| `BAE_LP_OAUTH2_CALLBACK` | `auth.idp.callbackUrl` | yes | `https://<proxy>/auth/fiware/callback`, registered as the redirect URL of the application |
| `BAE_AUTH__IDP__SCOPES` | `auth.idp.scopes` | no | What is asked at the login: `jwt,openid` with OIDC and `all_info` without it, as v11 did |
| `BAE_LP_OIDC_ENABLED` | `auth.idp.oidcEnabled` | no, `true` | `true`: the access token is a JWT signed by the manager. `false`: the manager is asked for the user |
| `BAE_LP_OIDC_KEY` | `auth.idp.oidcKey` | yes when `oidcEnabled` | Key the manager signs its JWTs with, 16 characters or more. **There is no default** |
| `BAE_LP_OAUTH2_DEFAULT_ROLE` | `auth.idp.defaultRole` | no | Role given to a user that arrives without roles |

The v12 keys can also be set as `BAE_AUTH__IDP__<KEY>` (for example `BAE_AUTH__IDP__OIDC_KEY`).

```
BAE_LP_OAUTH2_PROVIDER=fiware
BAE_LP_OAUTH2_SERVER=https://idm.example.org
BAE_LP_OAUTH2_CLIENT_ID=<application id>
BAE_LP_OAUTH2_CLIENT_SECRET=<application secret>
BAE_LP_OAUTH2_CALLBACK=https://bae.example.org/auth/fiware/callback
BAE_LP_OIDC_ENABLED=true
BAE_LP_OIDC_KEY=<key of the manager>
```

## Login

OAuth2 authorization code. The scope is `jwt,openid` with OIDC on and `all_info` with it off. The proxy authenticates to the token
endpoint (`<server>/oauth2/token`) with the client id and secret.

## How the user is read

| Mode | How the profile is obtained |
|---|---|
| OIDC (`oidcEnabled=true`) | The access token is a JWT. It is checked here with `oidcKey`, only with the algorithms HS256, HS384 and HS512, and an expired or badly signed one is refused. The identity manager is not called |
| Asking (`oidcEnabled=false`) | `GET <server>/user?access_token=<token>`. The token goes in the URL because the manager takes it there, so the access log of the manager holds it |

Fields: `id`, `username` (the display name or the id when the manager gives none), `displayName`, `email`, `roles` and
`organizations` as the manager returns them (`[{ id, name }]`, and each organization with its own `roles`, and `country` if it
has one). The expiry is the `exp` of the token when it has one. With no roles the user gets `defaultRole`, if set.

## Bearer without a login

Accepted when this is the main provider: the token is checked as above and the party is created if it did not exist. There is
no refresh token, so when it expires the client sends a new one.

## Refresh

`POST <server>/oauth2/token` with `grant_type=refresh_token`, the client credentials in the `Authorization: Basic` header and in the
body. The expiry is taken from `expires_in`.

## Notes

- Each organization of the user in the manager becomes an organization in TMForum, and the individual is told the role of the
  person in each.
- Changing the key invalidates every token signed with the old one.
