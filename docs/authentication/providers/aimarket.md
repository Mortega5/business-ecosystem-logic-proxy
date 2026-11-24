# Provider `aimarket` (AI Market identity manager)

Use it when users come from the AI Market, whose identity manager is a FIWARE one that also sends the personal data of the
person.

[Back to authentication](../../authentication.md)

## Settings

Set `BAE_LP_OAUTH2_PROVIDER=aimarket`. The settings are the ones of [`fiware`](fiware.md): `BAE_LP_OAUTH2_SERVER`, `_CLIENT_ID`,
`_CLIENT_SECRET`, `_CALLBACK`, `BAE_LP_OIDC_ENABLED`, `BAE_LP_OIDC_KEY` (required with OIDC, no default) and
`BAE_LP_OAUTH2_DEFAULT_ROLE`.

The scope is `jwt` with OIDC on and `all_info` with it off.

## How the user is read

As in [`fiware`](fiware.md) (the token is checked with the key, or the manager is asked), and in addition:

| Source | Field of the individual |
|---|---|
| `given_name`, `family_name` of the manager | Given and family name |
| `extra.aimData.user.firstname`, `lastname` | Given and family name, **overriding** the ones above when they are not empty |
| `extra.aimData.user.gender` | `M` is `Male`, `F` is `Female`, any other value is `Other` |
| `extra.aimData.user.academicTitle`, `language`, `pictureUrl` | Characteristics of the individual with those names |

`extra` is a JSON text. If it does not read, or has no `aimData.user`, it is ignored and the rest of the profile is built.

With the editing of the profile in the portal turned off (`BAE_LP_EDIT_PARTY=false`) these data are written to the individual on
each new profile; with it on, only when the individual is created.

## Refresh

As in `fiware`: `refresh_token` grant at `<server>/oauth2/token`. v11 defined no refresh for this provider, so a session ended
with the token.
