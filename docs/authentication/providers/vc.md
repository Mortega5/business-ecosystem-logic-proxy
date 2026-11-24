# Provider `vc` (SIOP, login with a wallet)

Login with a verifiable credential presented from a wallet, not with a password. It is part of the DOME integration and is
migrated with it.

[Back to authentication](../../authentication.md)

> **Status in v12:** not ported yet. It is seen apart, with the rest of the DOME integration.

It is enabled with `BAE_LP_SIOP_ENABLED=true`. The main identity provider is then `vc` and the `BAE_LP_OAUTH2_*` settings are not
used for the login.

| Variable | Meaning |
|---|---|
| `BAE_LP_SIOP_CLIENT_ID` | Identifier of the proxy as a verifier client |
| `BAE_LP_SIOP_PRIVATE_KEY`, `BAE_LP_SIOP_PRIVATE_KEY_PEM` | Key with which the proxy signs its requests |
| `BAE_LP_SIOP_CALLBACK_PATH`, `BAE_LP_SIOP_REQUEST_URI` | Callback of the wallet and URI of the request |
| `BAE_LP_SIOP_VERIFIER_HOST` | Host of the verifier, with `_QRCODE_PATH`, `_TOKEN_PATH` and `_JWKS_PATH` |
| `BAE_LP_SIOP_ALLOWED_ROLES` | Roles of the credential that are accepted |
| `BAE_LP_SIOP_OPERATORS` | Operators of the marketplace |
| `BAE_LP_SIOP_IS_REDIRECTION` | Redirect flow (`true`) or polling flow with `/poll` (`false`) |
| `BAE_LP_SIO_SIGN_ALGORITHM` | Signing algorithm (`ES256` by default) |
