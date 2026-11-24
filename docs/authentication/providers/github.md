# Provider `github`

Use it for a quick start or a demo, where anybody with a GitHub account can sell. It has no organizations and no roles other than
seller.

[Back to authentication](../../authentication.md)

## Settings

Set `BAE_LP_OAUTH2_PROVIDER=github`. All of these are required:

| v11 variable | v12 key | Meaning |
|---|---|---|
| `BAE_LP_OAUTH2_CLIENT_ID` | `auth.idp.clientId` | Client id of a GitHub OAuth application |
| `BAE_LP_OAUTH2_CLIENT_SECRET` | `auth.idp.clientSecret` | Its secret |
| `BAE_LP_OAUTH2_CALLBACK` | `auth.idp.callbackUrl` | `https://<proxy>/auth/github/callback`, the authorization callback URL of the application |

The role every user gets is the one named by `BAE_LP_OAUTH2_SELLER_ROLE`.

```
BAE_LP_OAUTH2_PROVIDER=github
BAE_LP_OAUTH2_CLIENT_ID=<client id>
BAE_LP_OAUTH2_CLIENT_SECRET=<client secret>
BAE_LP_OAUTH2_CALLBACK=https://bae.example.org/auth/github/callback
```

## Login

OAuth2 authorization code with the scope `user:email`.

## How the user is read

`GET https://api.github.com/user` with the access token. The id is the number of the account, the username the `login`, and the
display name and the email are the ones the account makes public (left out otherwise). Every user has no organizations and the
seller role.

## Refresh

None. GitHub OAuth tokens do not expire; the proxy keeps the profile for the time of the cache and then asks again.

## Bearer without a login

Accepted when this is the main provider: a client of the API can present the token of a GitHub account.
