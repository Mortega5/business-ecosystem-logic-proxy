# Provider `keycloak`

Use it when users are in a Keycloak realm.

[Back to authentication](../../authentication.md)

## Settings

Set `BAE_LP_OAUTH2_PROVIDER=keycloak`. All of these are required:

| v11 variable | v12 key | Meaning |
|---|---|---|
| `BAE_LP_OAUTH2_SERVER` | `auth.idp.server` | Base URL of Keycloak (a trailing `/` does not matter) |
| `BAE_LP_OIDC_REALM` | `auth.idp.realm` | Realm |
| `BAE_LP_OAUTH2_CLIENT_ID` | `auth.idp.clientId` | Id of a confidential client of the realm |
| `BAE_LP_OAUTH2_CLIENT_SECRET` | `auth.idp.clientSecret` | Its secret |
| `BAE_LP_OAUTH2_CALLBACK` | `auth.idp.callbackUrl` | `https://<proxy>/auth/keycloak/callback`, a valid redirect URI of the client |

The names of the roles that a group gives come from `BAE_LP_OAUTH2_SELLER_ROLE`, `_CUSTOMER_ROLE` and `_ORG_ADMIN_ROLE`.

```
BAE_LP_OAUTH2_PROVIDER=keycloak
BAE_LP_OAUTH2_SERVER=https://keycloak.example.org
BAE_LP_OIDC_REALM=dome
BAE_LP_OAUTH2_CLIENT_ID=bae
BAE_LP_OAUTH2_CLIENT_SECRET=<client secret>
BAE_LP_OAUTH2_CALLBACK=https://bae.example.org/auth/keycloak/callback
```

## Configuring Keycloak

- A confidential client (`Client authentication` on) with the standard flow, whose redirect URI is the callback.
- Client roles in the client (the roles of the platform: for example `seller`, `customer`, `admin`), assigned to the users.
- To act for organizations, a mapper that adds the groups of the user to the access token (claim `groups`).

## How the user is read

The proxy asks `<server>/realms/<realm>/protocol/openid-connect/userinfo` with the access token. From it: `id` (`sub`), `username`
(`preferred_username`, or the id), `displayName` (`name`) and `email`.

From the access token itself, which Keycloak has just accepted:
- **Roles**: the client roles of `resource_access[<clientId>].roles`. Roles of other clients and realm roles are not used.
- **Organizations**: every entry of `groups` is an organization of the user. Its id is the group; its name is the trading name of
  the organization in TMForum when the group is the id of one, and the group otherwise. In each the user gets the seller,
  customer and organization administrator roles.
- **Expiry**: the `exp` of the token.

## Refresh

`POST <server>/realms/<realm>/protocol/openid-connect/token` with `grant_type=refresh_token` and the client id and secret.

## Bearer without a login

Accepted when this is the main provider: the user info call is the check.
