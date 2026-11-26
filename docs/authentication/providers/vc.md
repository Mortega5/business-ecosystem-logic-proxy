# Provider `vc` (SIOP, login with a wallet)

Login with a verifiable credential that the user shows from a wallet, not with a password.

[Back to authentication](../../authentication.md)

It is enabled with `BAE_LP_SIOP_ENABLED=true` (`auth.vc.enabled`). The main identity provider is then `vc`, registered as `local`,
and the `BAE_LP_OAUTH2_*` settings are not used for the login. The routes `/login` and `/login/<idp>` answer 404 while it is on.

## How it works

The proxy is a client of a **verifier**. The user shows a credential to the verifier with a wallet; the verifier signs an access
token that carries the credential, and the proxy checks that token against the keys the verifier publishes
(`verifierHost` + `verifierJwksPath`; signature, algorithm, expiry, and the issuer when `verifierIssuer` is set).

There are two ways for the answer of the verifier to reach the proxy, chosen with `BAE_LP_SIOP_IS_REDIRECTION`:

- **Polling** (`false`, the default). The wallet is on another device. The portal shows a QR from the verifier
  (`verifierHost` + `verifierQrCodePath`, with a `state` it makes up and `client_callback` = `/auth/vc/callback`) and asks
  `GET /poll?state=<state>` every second. When the user shows the credential, the verifier calls
  `GET /auth/vc/callback?state=<state>&code=<code>`; the proxy keeps the code for five minutes, and the next poll exchanges it at
  `verifierHost` + `verifierTokenPath` (`grant_type=authorization_code`, `code`, `redirect_uri` = `callbackUrl`) and logs the
  browser in. A poll answers 401 `No auth code received yet` until then.
  The browser that asks first about a `state` is the only one that is given its answer (`bindPollToSession`, see below).
- **Redirection** (`true`). The wallet is on the same device. The portal sends the browser to the verifier with
  `request_uri` = `requestUri` (served by the proxy at `GET /auth/vc/request.jwt`: a JWT signed with the key of the proxy, `iss` and
  `client_id` the `clientId`, `aud` the verifier, `scope` `openid learcredential`), and the verifier sends the browser back to
  `GET /auth/vc/callback?state=<state>&code=<code>`. The proxy exchanges the code with a client assertion (`private_key_jwt`: a JWT
  signed with the key of the proxy, `iss` and `sub` the `clientId`, `aud` the verifier, 30 seconds) and redirects to
  `/dashboard?token=local`, or to `/error` when the login does not complete.

In both cases the session of the browser is a new one once the user is logged in (the previous one is dropped), and keeps only the
access token; the profile is in the authentication store.

## Settings

| v11 variable | v12 key | Meaning |
|---|---|---|
| `BAE_LP_SIOP_ENABLED` | `auth.vc.enabled` | Turns the login on. Only `true` enables it |
| `BAE_LP_SIOP_IS_REDIRECTION` | `auth.vc.isRedirection` | Redirection (`true`) or polling (`false`, default) |
| `BAE_LP_SIOP_CLIENT_ID` | `auth.vc.clientId` | Identifier of the proxy at the verifier. Required; there is no default |
| `BAE_LP_SIOP_PRIVATE_KEY` | `auth.vc.privateKey` | The EC private key (curve P-256) as 32 bytes in hexadecimal |
| `BAE_LP_SIOP_PRIVATE_KEY_PEM` | `auth.vc.privateKeyFile` | Path of a PEM file with the private key; it is used before `privateKey`. One of the two is required; both are read when the proxy starts |
| `BAE_LP_SIO_SIGN_ALGORITHM` | `auth.vc.signAlgorithm` | `ES256` by default (the variable is called `SIO`, not `SIOP`) |
| `BAE_LP_SIOP_CALLBACK_PATH` | `auth.vc.callbackUrl` | Full address of `/auth/vc/callback` on the site the user and the verifier reach. Required; it is the `redirect_uri` of the exchange |
| `BAE_LP_SIOP_REQUEST_URI` | `auth.vc.requestUri` | The path of the request, as the portal builds `request_uri`. `/auth/vc/request.jwt` by default; the proxy serves it at that path only |
| `BAE_LP_SIOP_VERIFIER_HOST` | `auth.vc.verifierHost` | Address of the verifier. Required |
| `BAE_LP_SIOP_VERIFIER_QRCODE_PATH` | `auth.vc.verifierQrCodePath` | `/api/v1/loginQR` by default |
| `BAE_LP_SIOP_VERIFIER_TOKEN_PATH` | `auth.vc.verifierTokenPath` | `/token` by default |
| `BAE_LP_SIOP_VERIFIER_JWKS_PATH` | `auth.vc.verifierJwksPath` | `/.well-known/jwks` by default |
| | `auth.vc.verifierIssuer` | When set, a token has to be issued by it (`iss`). Not checked when it is not set |
| `BAE_LP_SIOP_OPERATORS` | `auth.vc.operators` | Comma separated: issuers, or organisation identifiers, whose users are administrators of the platform |
| `BAE_LP_SIOP_CERT_ISSUERS` | `auth.vc.certIssuers` | Comma separated: the DIDs of the issuers trusted to certify a product (see below). With none, no certificate is accepted |
| `BAE_LP_OAUTH2_ORG_CERTIFIER_ROLE` | `auth.roles.certifier` | Name of the role of a certifier (`certifier` by default) |
| | `auth.vc.bindPollToSession` | `true` by default: the poll needs the session cookie of the browser |

`GET /config` gives the portal a `siop` object: `{ "enabled": false }` when the login is off, and with the login on `enabled`,
`isRedirection`, `pollPath` (`/poll`), `pollCertPath` (`/cert/poll`), `clientID`, `callbackURL`, `verifierHost`,
`verifierQRCodePath` and `requestUri`.

The proxy refuses to start with the login on and without `clientId`, a private key, `callbackUrl` and `verifierHost`, or when the key
cannot be read.

## How the user is read

From the credential in the token of the verifier. The token carries it as it is (`credentialSubject`), or inside `vc`,
`verifiableCredential` or `verifiablePresentation` (the presentation of a LEAR credential is preferred). Its type decides the format:

- **`LEARCredentialEmployee` and `LEARCredentialMachine`** (also `learcredential.employee.w3c.*` and `learcredential.machine.w3c.*`).
  The mandatee is the user and the mandator is the organisation: `id` is the id of the mandatee (or the subject), `email`, `firstName`
  and `familyName` (`first_name` and `last_name` are accepted) come from the mandatee, and for a machine the address falls back to its
  `contact.email` or to the one of the mandator, and the name to its `serviceName`. The organisation is `organizationIdentifier`
  (id), `organization` (name) and `country`. The user has no roles, except the administrator role when the issuer, or the
  `organizationIdentifier`, is one of `operators`. The roles in the organisation come from the powers of the mandate, whose function
  and action are read in any of the spellings the issuers use (`function`/`action`, `tmf_function`/`tmf_action`,
  `tmfFunction`/`tmfAction`): `onboarding` with `execute` gives the organisation administrator role, `productoffering` with `create`
  and `update` the seller role, and `certification` with `upload` or `post_verifiable_certification` (an employee also with
  `uploadCertificate`) the certifier role.
- **The credential of the issuer of FIWARE** (any other type). `id` and `email` are the address of the subject (or `<issuer>:individual`
  and `<issuer with dots>@email.com` when it has none), the roles are the names of its first group of roles, and the organisation is the
  issuer, with the seller, customer and organisation administrator roles.

The user name is the part of the address before the `@`, the display name is the first name and the family name, the expiry is the `exp`
of the token, and the issuer is kept as `issuerDid`.

A bearer token that the proxy has not seen is checked the same way: it has to be signed by the verifier.

## Certificates

The portal also uses the wallet to certify a product. It asks the verifier for a QR with a `state` that starts with `cert:` and polls
`GET /cert/poll?state=<state>`. The verifier tells the proxy the code at `/auth/vc/callback` (polling mode), the proxy exchanges it at
once and keeps the token for 100 seconds, and the poll answers (once) `{ "vc": <token>, "subject": <what the credential certifies> }`
when the token is signed by the verifier, its credential is issued by one of `certIssuers`, it has not expired and its subject has
`product` and `compliance`. Anything else is a 400 (`Invalid VC`, `Invalid VC issuer`, `The VC is expired`, `Invalid VC subject`); 401
`VC not found` is the answer while there is no credential. The portal then uploads the credential with
`PATCH /admin/uploadcertificate/:specId`.

## Behind a proxy

The calls to the verifier are made with the global `fetch` of Node: to send them through an HTTP proxy start Node with
`NODE_USE_ENV_PROXY=1` and set `HTTPS_PROXY` and `HTTP_PROXY`.

## Refresh

The proxy refreshes with `grant_type=refresh_token` and a client assertion, when the verifier gave a refresh token. Without one, the
token is not refreshed and the user logs in again when it ends.
