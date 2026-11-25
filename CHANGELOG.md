# Changelog

## 12.0.0

The proxy is a NestJS application. The Express 4 application of version 11 is gone, with `config.js`, Passport and its strategies.

### What has to change in a deployment

- `auth.session.secret` (`BAE_AUTH__SESSION__SECRET`) is required, with at least 32 characters. The server does not start without it.
- The main identity provider has to be complete (`BAE_LP_OAUTH2_*`, or `BAE_LP_SIOP_*` with `BAE_LP_SIOP_ENABLED=true`). There is no default OIDC key: `BAE_LP_OIDC_KEY` is required when `BAE_LP_OIDC_ENABLED` is on.
- The `BAE_LP_*` variables of version 11 keep working and the log names the key that replaces each. `config.js` is not read: use environment variables or a YAML file (`CONFIG_FILE`).
- The operator of the marketplace is `operator.id` (`BAE_LP_OPERATOR_ID`).
- `BAE_LP_SIOP_CERT_ISSUERS` lists the issuers of the credential of a certification (`/cert/poll`); without it every credential is refused. `BAE_LP_SIOP_ALLOWED_ROLES` is not used.
- `HTTPS_PROXY` is not applied to the calls of the proxy: start Node with `NODE_USE_ENV_PROXY=1`.
- The image does not collect static files, load themes or run migration scripts. It serves the compiled portal in `portal/bae-frontend`.
- A portal on another origin needs that origin in `http.cors.origins` to send the cookie of the session.

### Routes that are no longer served

The portal does not call them.

- `POST /billing/order`, `POST /billing/orderRaw`
- `/apiKeyService/*`, `/authorizeService/*`
- `/SLAManagement/*`, `/RECManagement/*`, `/PromManagement/*`, `/REPManagement/*`
- `/rss/*`
- `GET /shoppingCart/item/:id`
- `/admin/<api>/*`, the generic proxy for administrators, except `PATCH /admin/catalog/catalog/:id` and `/admin/uploadcertificate`
- the API of datasets of the proxy: the portal writes them, and a file goes to `/file`

### Changes in behaviour

- The login is done by the proxy: OpenID Connect with `state`, `nonce` and PKCE, and OAuth2 with `state` and PKCE. Sessions and tokens are kept in the store of `auth.store` (memory or MongoDB).
- `/logintoken` answers 401 without credentials, and gives only the fields the portal reads.
- `X-Organization` makes the caller act as one of their organizations; one that is not theirs is a 401.
- A GET that no route answers is the page of the portal for a browser, and a 404 for any other client.
- `/blog` is the route of the blog. `/domeblog` is an alias that exists while `dome.enabled` is on.
- The login with credentials (`vc`) is a provider of the core: the role of a seller needs the function that grants it, and the answer of `/poll` goes only to the browser that asked first.
