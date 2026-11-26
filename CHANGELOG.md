# Changelog

## 12.0.0

The proxy is a NestJS application on Express 5 and Node.js 26. The Express 4 application of version 11 is gone, with `config.js`, Passport and its strategies. Each API is a controller with its routes written out, taken from what the portal calls; what is not listed is not proxied.

### Highlights

**Configuration**
- Layered: `config/default.yaml`, then a YAML file (`CONFIG_FILE`, or `/etc/bae/config/application.yaml` when it exists), then environment variables named `BAE_<SECTION>__<KEY>` (`BAE_MONGO__RETRY_MAX_DELAY_MS` is `mongo.retryMaxDelayMs`; arrays and objects are JSON).
- Validated at start-up with a schema: an invalid key stops the server and the message names it. There are no default hosts or secrets.
- The `BAE_LP_*` variables of version 11 are still read, with a warning in the log that names the key that replaces each. See [docs/kubernetes.md](docs/kubernetes.md#configuration).
- MongoDB is given as a `mongo.uri`, or in parts (`mongo.host`, `port`, `database`, `user`, `password`, `authSource`), never both. The user and the password go to the connection as they are, so they need no encoding and are not in the address that is logged.
- The services the proxy calls are grouped in blocks (`upstreams.tmforum`, `charging`, `revenue`, `search`) whose APIs inherit the host, port, scheme and timeout of their group.
- What the proxy takes or reads is a setting: body and upload sizes (`http.bodyLimit`, `http.uploadLimit`), and the `limits.*` of orders, cart items, notes, names, descriptions and lists.

**Features**
- Every feature has an `enabled` switch with its settings next to it. An administrator changes the switches at run time from the portal (`PATCH /config/features`), and the change is read by every instance within 5 seconds. The portal reads its settings from `GET /config`, which a module can extend.
- An administrator also edits the filters of the search, the search engine setting, the default catalog and the settings of the analytics from the portal.
- New switches: `datasets`, `apiAccess`, `blueprints`, `software`, `blogEnabled`, `complianceEnabled`, and `party.editEnabled` for `BAE_LP_EDIT_PARTY`.

**Authentication**
- The login is done by the proxy. OpenID Connect providers use `openid-client` with `state`, a `nonce` per login and PKCE; the others use OAuth2 with `state` and PKCE.
- A user keeps the identity they had in version 11 with every provider. With `oidc-discover`, a token that carries a verifiable credential says who the user is by it (the person, their organization and their roles), as in version 11; a credential that is there and cannot be read refuses the login.
- The role of a certifier is `auth.roles.certifier` (`certifier` by default; `BAE_LP_OAUTH2_ORG_CERTIFIER_ROLE`), and `/config` always gives it to the portal.
- Providers: FIWARE IDM, Keycloak, any OpenID Connect provider (discovery), GitHub, AI Market, i4Trust and the verifiable-credentials login (`vc`, below). Identity providers added by an administrator (`/IDP`) work with the external login.
- Tokens are refreshed before they end and the refresh of one token is made once however many requests wait for it. The profile of a token is kept in memory or in MongoDB (`auth.store.type`), sealed with AES-256-GCM in MongoDB, and sessions are kept in the same store so that every instance sees them.
- A route is private unless it says otherwise. A caller is known by `X-Auth-Token`, `Authorization: Bearer` or the session cookie, and `X-Organization` makes them act as one of their organizations.
- `/login`, `/login/:idp`, `/auth/:idp/callback`, `/logOut` and `/logintoken`. A redirect after the login can only go to a path of this site.
- See [docs/authentication.md](docs/authentication.md) and a page for each provider.

**Verifiable credentials (`vc`/SIOP)**
- A provider of the core, which replaces the main provider with `BAE_LP_SIOP_ENABLED=true`. The profile and the roles come from the credential, and the access token is checked against the keys of the verifier.
- The answer of `/poll` goes only to the browser that asked first. `BAE_LP_SIOP_CERT_ISSUERS` lists the issuers allowed for the credential of a certification.

**Files**
- `/file` streams the files of a seller to and from a file service (`fileService.*`), which keeps them behind the organization that uploaded them and checks size and type. A product or a service that names a file that is not the seller's is refused.

**Blog, analytics and compliance**
- Moved to the core, each with its own settings and switch. `/blog` is the route of the blog; `/domeblog` is an alias while `dome.enabled` is on. The analytics give a guest token for the dashboards of an Apache Superset, and the compliance check and the upload of a certificate are served by the proxy.

**Operation**
- `/health/live` and `/health/ready` (which follows MongoDB), an orderly shutdown on `SIGTERM` and `SIGINT` that waits for the requests in flight, and a MongoDB connection that is made again with a growing delay after an outage.
- Structured logs with `pino` (`logging.format`: `pretty` or `json`), with identifiers and never bodies or secrets, and a line for every failure of a third party.
- HTTPS from the configuration, and security headers, protection against cross-site requests and CORS from `security.*` and `http.cors.*`.
- The operator of the marketplace is found in the party API at start-up, with retries, and every day. It is `operator.id` (`BAE_LP_OPERATOR_ID`).
- The figures of the landing page are served from a cache in MongoDB with a time to live, with no schedule.
- Lists take one `page` and `sort` convention and at most 1000 elements. Every route is documented in [docs/openapi.yaml](docs/openapi.yaml), and a test fails when a route and its documentation differ.
- A failure at a third party is an error to the client, and the log says what was created before it.

### What has to change in a deployment

- `auth.session.secret` (`BAE_AUTH__SESSION__SECRET`) is required, with at least 32 characters. It signs the cookie of the session, and every instance must have the same one. The server does not start without it.
- The main identity provider has to be complete (`BAE_LP_OAUTH2_*`, or `BAE_LP_SIOP_*` with `BAE_LP_SIOP_ENABLED=true`). There is no default OIDC key: `BAE_LP_OIDC_KEY` is required when `BAE_LP_OIDC_ENABLED` is on.
- `config.js` is not read: use environment variables or a YAML file.
- `HTTPS_PROXY` is not applied to the calls of the proxy: start Node with `NODE_USE_ENV_PROXY=1`.
- `BAE_LP_SIOP_ALLOWED_ROLES` is not used, and `callback_url` of the query of the `vc` login is ignored.
- The image does not collect static files, load themes or run migration scripts. It serves the compiled portal in `portal/bae-frontend`.
- The charging backend is at port 8006 unless `upstreams.charging.port` says otherwise; it has no default host.
- `jsonwebtoken` is 9: an RSA key of less than 2048 bits no longer signs or verifies (the key of the proxy for i4Trust, the keys of a verifier), and an `ES*` algorithm needs a key of its curve (`ES256` is P-256, which is the key of `BAE_LP_SIOP_PRIVATE_KEY`).
- A portal on another origin needs that origin in `http.cors.origins` to send the cookie of the session.
- Several instances need `auth.store.type=mongo` (with `auth.store.encryptionKey`), or each keeps its own sessions.

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

- `/logintoken` answers 401 without credentials, and gives only the fields the portal reads.
- A GET that no route answers is the page of the portal for a browser, and a 404 for any other client.
- `vc`: the role of a seller needs the function that grants it (version 11 gave it to any credential with create and update), and `/cert/poll` works (it never did).
- Lists by several `lifecycleStatus` are filtered, paged and counted by the TMForum API.
