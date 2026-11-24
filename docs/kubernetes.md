# Running on Kubernetes

Technical reference for the Nest application started by `dist/main.js`. The endpoints it implements are
described in [openapi.yaml](openapi.yaml).

## Process

| | |
|---|---|
| Command | `node dist/main` (`pnpm start:prod`), after `pnpm build` |
| Node.js | 26 or later |
| Listening port | `app.port`, `8004` by default |
| Listening address | `app.host` when set; otherwise Node's default, which is every interface over IPv6 and IPv4 |
| Working directory | `config/default.yaml` is read relative to it, so it is the repository root; `server.js` is loaded from the directory above `dist/` |

The application serves two sets of routes on the same port. Requests are matched against the routes implemented
by Nest first; those that match none are handled by the legacy Express application (`server.js`), which is
configured separately, through its `BAE_LP_*` environment variables and `config.js`.

The image built from `docker/Dockerfile` runs `pnpm build` and its entrypoint ends with `exec node dist/main`, so
the process receiving `SIGTERM` is the Node.js one. Its `HEALTHCHECK` requests `/health/live` over HTTP, with a
start period of 120 seconds; with `app.https.enabled` set it needs to be overridden.

## HTTPS

Disabled by default. With `app.https.enabled` set to `true` the server listens on `app.port` over TLS and no longer
answers plain HTTP on that port; the Nest routes and the legacy ones are served the same way. The key and
certificate files are read when the server starts; `app.https.keyFile` and `app.https.certFile` are required once
HTTPS is enabled and `app.https.caFile` is optional.

TLS 1.0 and 1.1 are excluded, and TLS 1.2 connections use the legacy application's cipher list
(`ECDHE-RSA-AES256-SHA384:DHE-RSA-AES256-SHA384:ECDHE-RSA-AES256-SHA256:DHE-RSA-AES256-SHA256:ECDHE-RSA-AES128-SHA256:DHE-RSA-AES128-SHA256:HIGH`
without `aNULL`, `eNULL`, `EXPORT`, `DES`, `RC4`, `MD5`, `PSK`, `SRP` and `CAMELLIA`) in the server's order of preference.

With HTTPS enabled, the probes need `scheme: HTTPS`:

```yaml
livenessProbe:
  httpGet: { path: /health/live, port: 8004, scheme: HTTPS }
```

## Start-up

`server.js` is loaded before the Nest application is created, and it waits for its own dependencies
(MongoDB, the identity provider) while loading. The port is not open until that finishes. Progress is logged
with `context: "Bootstrap"`:

| Level | Message | When |
|---|---|---|
| info | `Starting the server` | Immediately, with `port` and, when set, `host` |
| warn | `Still loading the legacy application, it waits for its dependencies such as MongoDB` | Every 5 seconds while loading, with `waitedSeconds` |
| info | `Legacy application loaded` | `server.js` finished loading |
| info | `Server listening` | The port is open |
| fatal | `The server could not start` | Any failure; the process exits with code 1 |

A configuration that cannot be loaded is written to stderr and the process exits with code 1.

## Probes

| Probe | Request | Healthy | Not healthy |
|---|---|---|---|
| Liveness | `GET /health/live` | `200` `{"status":"ok"}` | The process does not answer |
| Readiness | `GET /health/ready` | `200` | `503` while MongoDB does not reply |

`/health/live` checks no dependency. `/health/ready` pings MongoDB, waits at most `health.mongoPingTimeoutMs`
and is evaluated on every call. Bodies:

```json
{ "status": "ok", "info": { "mongodb": { "status": "up" } }, "error": {}, "details": { "mongodb": { "status": "up" } } }
```

```json
{
  "status": "error",
  "info": {},
  "error": { "mongodb": { "status": "down", "message": "MongoDB is not reachable" } },
  "details": { "mongodb": { "status": "down", "message": "MongoDB is not reachable" } }
}
```

Requests to both routes are not written to the access log.

Example configuration; the timings depend on how long `server.js` takes to load:

```yaml
containers:
  - name: proxy
    ports:
      - containerPort: 8004
    startupProbe:
      httpGet: { path: /health/live, port: 8004 }
      periodSeconds: 5
      failureThreshold: 24
    livenessProbe:
      httpGet: { path: /health/live, port: 8004 }
      periodSeconds: 10
      failureThreshold: 3
    readinessProbe:
      httpGet: { path: /health/ready, port: 8004 }
      periodSeconds: 5
      failureThreshold: 3
```

## Shutdown

`SIGTERM` and `SIGINT` start an orderly shutdown, in this order:

1. The retries of the start-up loaders of the legacy application (charging information, statistics, operator)
   and its scheduled refreshes are cancelled.
2. `/health/ready` answers `503` with status `shutting_down`. On `SIGTERM` the server keeps accepting requests
   for `app.shutdownDelayMs` (no wait when it is `0`, and none for `SIGINT`); `/health/live` keeps answering `200`.
3. The HTTP server stops accepting connections and waits for the requests in flight to finish.
4. The Nest MongoDB connection is closed, then the connections of the legacy application.
5. The process exits with code 0.

Before the application is up (while it waits for MongoDB, for instance) there is nothing to drain: a signal ends the
process at once, and `docker/entrypoint.sh` does the same while it waits for MongoDB before starting. As PID 1 a process
without a handler ignores `SIGTERM`, so a pod stuck at start-up would otherwise only stop when Kubernetes kills it.

If the shutdown has not finished `app.shutdownTimeoutMs` after the signal, the process exits with code 1.
`app.shutdownTimeoutMs` must be greater than `app.shutdownDelayMs`. Kubernetes sends `SIGKILL` when
`terminationGracePeriodSeconds` elapses, so that value should exceed `app.shutdownTimeoutMs`.

| Level | Message | |
|---|---|---|
| info | `Shutting down` | With `signal` and `timeoutMs` |
| info | `Shutdown complete` | |
| fatal | `Shutdown did not finish in time, exiting` | Exit code 1 |
| fatal | `Shutdown failed` | With the error; exit code 1 |

## MongoDB connection

The Nest application opens its connection after it starts, without blocking it, and keeps trying until it
succeeds: the delay between attempts starts at `mongo.retryInitialDelayMs`, doubles on each failure and is
capped at `mongo.retryMaxDelayMs`. Once connected, the driver reconnects by itself after an outage;
`mongo.heartbeatFrequencyMs` sets how often it checks the server. Index creation is disabled.

Logged with `context: "MongoConnectionService"`:

| Level | Message |
|---|---|
| warn | `MongoDB is not reachable, retrying` (with `attempt` and `delayMs`) |
| info | `MongoDB connection established` |
| warn | `MongoDB connection lost` |
| info | `MongoDB connection restored` |
| error | `MongoDB connection error` |

## Configuration

Values are resolved in this order, each layer overriding the previous one:

1. `config/default.yaml`, shipped with the application.
2. The [legacy variables](#legacy-environment-variables) listed below.
3. The YAML file named by `CONFIG_FILE`, or `/etc/bae/config/application.yaml` when `CONFIG_FILE` is not set.
   The default file is optional; a file named by `CONFIG_FILE` must exist.
4. Environment variables named `BAE_<SECTION>__<KEY>`.

Environment variable names: `__` separates levels and a single `_` inside a level is a camelCase boundary, so
`BAE_MONGO__RETRY_MAX_DELAY_MS` is `mongo.retryMaxDelayMs`. Arrays and objects are given as JSON. Variables
without `__` after `BAE_` (the legacy `BAE_LP_*` ones) are ignored by this mechanism.

The configuration is validated at start-up and read only then: changing the file or a variable requires
restarting the container.

Mounting the file:

```yaml
containers:
  - name: proxy
    env:
      - name: BAE_MONGO__URI
        valueFrom:
          secretKeyRef: { name: proxy-secrets, key: mongo-uri }
    volumeMounts:
      - { name: config, mountPath: /etc/bae/config, readOnly: true }
volumes:
  - name: config
    configMap: { name: proxy-config }   # key: application.yaml
```

### Legacy environment variables

Variables of the legacy application that also configure the Nest application:

| Variable | Configures | Notes |
|---|---|---|
| `BAE_LP_PORT` | `app.port` | Used while HTTPS is not enabled |
| `BAE_LP_HTTPS_ENABLED` | `app.https.enabled` | Only the value `true` enables HTTPS |
| `BAE_LP_HTTPS_CERT`, `BAE_LP_HTTPS_KEY`, `BAE_LP_HTTPS_CA` | `app.https.certFile`, `app.https.keyFile`, `app.https.caFile` | |
| `BAE_LP_HTTPS_PORT` | `app.port` | Used while HTTPS is enabled; `443` when it is not set |
| `BAE_LP_MONGO_SERVER`, `BAE_LP_MONGO_PORT`, `BAE_LP_MONGO_DB`, `BAE_LP_MONGO_USER`, `BAE_LP_MONGO_PASS` | `mongo.uri` | `mongodb://[user:password@]server:port/db`. Parts that are not set take the values of the legacy application: server `mongo`, port `27017`, database `belp`. Credentials are used only when both a user and a password are set, and are percent-encoded |
| `BAE_LP_CONTACT_US_NOTIFICATION_URL` | `upstreams.contactUs` | Where the contact form is notified, as one URL (host, port, scheme and path are taken from it, the query is not); without it the form is notified to the charging backend. Also `BAE_UPSTREAMS__CONTACT_US__HOST` and the like |
| `BAE_GIT_HASH` | | Not configuration: the commit of the build, shown by `GET /version` |
| `BAE_LP_PURCHASE_ENABLED`, `BAE_LP_DATASPACE_ENABLED`, `BAE_LP_CATALOG_MANAGEMENT_ENABLED`, `BAE_LP_DSP_ENABLED`, `BAE_LP_QUOTE_ENABLED`, `BAE_LP_TENDERING_ENABLED`, `BAE_LP_LAUNCH_VALIDATION_ENABLED` | `http.uploadLimit` | size | `50mb` | Largest file upload (multipart body) a route accepts; a bigger one is refused with 413 |
| `http.cors.origins` | list of origins or `"*"` | `["*"]` | Origins that may call the API from a browser; `*` is what the legacy application did |
| `http.cors.exposeRedirect` | boolean | `false` | Exposes `X-Redirect-URL` to the browser |
| `security.csp.reportOnly` | boolean | `true` | Sends `Content-Security-Policy-Report-Only` instead of enforcing the policy |
| `security.hsts.enabled`, `.maxAgeSeconds`, `.includeSubDomains` | boolean, integer, boolean | `true`, `31536000`, `false` | `Strict-Transport-Security`; browsers ignore it over plain HTTP |
| `security.crossOriginResourcePolicy` | `same-origin` `same-site` `cross-origin` | `same-origin` | |
| `security.csrf.enabled` | boolean | `true` | Refuses state-changing requests a browser says come from another site |
| `security.csrf.trustedOrigins` | list of origins | `[]` | Origins exempt from that check; meant for tests and development |
| `auth.propagateToken` | boolean | `true` | Sends the user's access token to the upstreams as `Authorization: Bearer` |
| `auth.allowLocalEori` | boolean | `false` | A local IdP user acts under their display name as IdP id |
| `auth.roles.admin`, `.customer`, `.seller`, `.orgAdmin` | string | `admin`, `Buyer`, `Seller`, `orgAdmin` | Names of the roles in the identity provider |
| `purchase.enabled`, `dataSpace.enabled`, `catalogManagement.enabled`, `dsp.enabled`, `quotes.enabled`, `tendering.enabled`, `launchValidation.enabled` | Anything other than `true` turns the feature off |
| `BAE_LP_TENDER_DEV_BUTTON_ENABLED` | `tendering.devButtonsOpenClose` | Same rule |
| `BAE_LP_PAYMENT_GATEWAY`, `BAE_LP_PAYMENT_PROVIDER` | `purchase.paymentGateway`, `purchase.paymentProvider` | The provider is trimmed and lowercased; blank means `none` |
| `BAE_LP_QUOTE_API` | `quotes.api` | |
| `BAE_LP_DSP_CONTRACT_DEFINITION_SCHEMA` | `dsp.contractDefinitionSchema` | |
| `BAE_LP_OFFERING_SCHEMA`, `BAE_LP_PRICE_COMP_SCHEMA`, `BAE_LP_BLUEPRINT_SCHEMA`, `BAE_LP_PARTY_LOCATION` | `catalog.offeringSchema`, `catalog.priceCompSchema`, `catalog.blueprintSchema`, `catalog.partyLocation` | |
| `BAE_LP_DEFAULT_CATALOG_ID`, `BAE_LP_DEFAULT_CATALOG_NAME` | `catalog.defaultCatalogId`, `catalog.defaultCatalogName` | |
| `BAE_LP_CORS_EXPOSE_REDIRECT` | `http.cors.exposeRedirect` | Anything other than `true` turns it off |
| `BAE_LP_PROPAGATE_TOKEN`, `BAE_LP_ALLOW_LOCAL_EORI` | `auth.propagateToken`, `auth.allowLocalEori` | Anything other than `true` turns the option off |
| `BAE_LP_OAUTH2_ADMIN_ROLE`, `_SELLER_ROLE`, `_CUSTOMER_ROLE`, `_ORG_ADMIN_ROLE` | `auth.roles.admin`, `.seller`, `.customer`, `.orgAdmin` | |
| `BAE_LP_ENDPOINT_<NAME>_HOST`, `_PORT`, `_PATH`, `_SECURED` | `upstreams.tmforum.apis.<api>` or `upstreams.<name>` | See [Upstreams](#upstreams) for the names. `SECURED=true` sets `scheme: https`. What is not set (host or port) comes from the group; a missing `PATH` means the path the legacy application had for that endpoint, which is empty except for `revenue` (`/revenue`) and `invoicing` (`/invoicing`) |

When none of the `BAE_LP_MONGO_*` variables is set, `mongo.uri` keeps its default.

Each variable in use is logged at start-up, with `context: "Bootstrap"`:

| Level | Message | Fields |
|---|---|---|
| warn | `Deprecated environment variable, still applied` | `variable`, `key` (the configuration key it sets) and `replacement` (the `BAE_<SECTION>__<KEY>` name) |

### Keys

Keys read by the application:

| Key | Type | Default | |
|---|---|---|---|
| `app.host` | string | not set | Listening address |
| `app.port` | integer 1–65535 | `8004` | Listening port |
| `app.https.enabled` | boolean | `false` | Serves HTTPS instead of HTTP |
| `app.https.keyFile`, `app.https.certFile` | string | not set | PEM files; required when `app.https.enabled` is `true` |
| `app.https.caFile` | string | not set | PEM file with the certificate authority chain |
| `app.shutdownDelayMs` | integer ≥ 0 | `0` | Time the server keeps accepting requests, with readiness at 503, after `SIGTERM` |
| `app.shutdownTimeoutMs` | integer, greater than `app.shutdownDelayMs` | `20000` | Maximum duration of the shutdown |
| `logging.level` | `fatal` `error` `warn` `info` `debug` `trace` `silent` | `info` | |
| `logging.format` | `json` `pretty` | `pretty` | `pretty` uses pino-pretty |
| `logging.prettyOptions` | object | `{ singleLine: true }` | Options for pino-pretty |
| `mongo.uri` | string | `mongodb://localhost:27017/belp` | |
| `mongo.maxPoolSize` | integer | `10` | |
| `mongo.serverSelectionTimeoutMs` | integer | `5000` | How long each connection attempt waits for a server |
| `mongo.heartbeatFrequencyMs` | integer ≥ 500 | `10000` | |
| `mongo.retryInitialDelayMs` | integer | `1000` | |
| `mongo.retryMaxDelayMs` | integer | `30000` | |
| `purchase.enabled` | boolean | `true` | |
| `purchase.paymentProvider` | `dpas` `paypal` `stripe` `none` | `none` | |
| `purchase.paymentGateway` | URL | not set | Required when the provider is `dpas`; there is no default |
| `quotes.enabled` | boolean | `true` | |
| `quotes.api` | string | `/quote/quoteManagement` | |
| `tendering.enabled` | boolean | `true` | |
| `tendering.devButtonsOpenClose` | boolean | `false` | |
| `dsp.enabled` | boolean | `false` | |
| `dsp.contractDefinitionSchema` | URL | not set | Required when `dsp.enabled` is `true` |
| `launchValidation.enabled`, `dataSpace.enabled` | boolean | `false` | |
| `catalogManagement.enabled` | boolean | `true` | |
| `catalog.offeringSchema`, `catalog.priceCompSchema`, `catalog.blueprintSchema`, `catalog.partyLocation` | URL | the legacy values | `@schemaLocation` of offerings, price components, blueprint product specifications and the related parties of what the operator owns |
| `catalog.defaultCatalogId` | string | empty | The default catalog, which lists the root categories the marketplace shows; when it is set it is the one used and it has to exist. When it is empty the proxy takes the stored one, the one the catalog API marks with the catalog type `default`, or makes one |
| `catalog.defaultCatalogName` | string | `default` | The name of the default catalog the proxy makes, and with which it recognises the one made before the catalog type existed |
| `catalog.bootstrap.enabled` | boolean | `true` | Whether the proxy makes sure, every time it starts, of the default catalog, the system categories (in the default catalog) and the support package spec of the software. Off, it does nothing and what is not there is not made; the default catalog is then the one of `catalog.defaultCatalogId`, if any |
| `catalog.bootstrap.retryDelayMs` | integer | `5000` | The wait before the start-up tries again when the TMForum APIs do not answer |
| `catalog.bootstrap.records.defaultCatalog`, `catalog.bootstrap.records.supportPackageSpec` | string | `default`, `global` | The ids of the records (in `defaultcatalog` and `supportpackagespec`) in which the start-up keeps what it found. They are the ones of v11: changing them leaves what it stored unread, and it looks for it again |
| `catalog.systemCategories` | list of `key`, `name`, `description` | `dataset`, `api`, `blueprint` | The categories of the platform, one per kind of product; the proxy makes them, adds them to the default catalog, and does not let them be retired, renamed or moved. A catalog cannot be named as one of them |
| `upstreams.timeoutMs` | integer | `30000` | Timeout of every upstream that does not set its own |
| `upstreams.tmforum.host`, `.port`, `.scheme` | string, integer, `http` `https` | not set (`http` when no scheme is given) | Default server of every TMForum API |
| `upstreams.tmforum.apis.<api>.host`, `.port`, `.scheme`, `.path`, `.timeoutMs` | | the standard TMForum paths | What one API sets itself; see [Upstreams](#upstreams) |
| `upstreams.charging`, `.revenue`, `.search` | `host`, `port`, `scheme`, `path`, `timeoutMs` | not set (`revenue.path` is `/revenue`) | The services that are not TMForum APIs |
| `limits.orderItems` | integer | `50` | Items that one product order may have |
| `limits.cartItems` | integer | `100` | Items that the shopping cart of a user may hold |
| `limits.noteLength`, `limits.notesPerRequest` | integer | `10000`, `20` | Characters of a note of an order, and notes that one request adds |
| `limits.nameLength`, `limits.descriptionLength` | integer | `100`, `100000` | Characters of the name and of the description of a specification or a category |
| `limits.plansPerQuery` | integer | `20` | Price plans that one query to the catalog asks for, when the proxy looks for the offers that use a usage specification |
| `limits.providersPerQuery`, `limits.providerCacheMs` | integer | `50`, `300000` | The directory of providers, when the marketplace has no search engine: the organisations that one query to the party API asks for, and the milliseconds that the organisations with launched offerings are kept before they are looked for again |
| `limits.readAll.pageSize`, `limits.readAll.maxPages` | integer | `100`, `100` | When the proxy reads everything that a TMForum collection has (what uses a specification, the catalogs of the start-up): the items it asks for in a page, and the pages it reads at most before it gives up |
| `stats.ttlMs`, `stats.retryDelayMs` | integer | `86400000`, `600000` | The figures of the landing page (`GET /stats`): the milliseconds that they are kept in Mongo before a request makes the proxy read them again, in the background (the request is answered with what is kept), and the ones to wait before trying again when that read failed |
| `stats.providerTtlMs` | integer | `60000` | The milliseconds that the counts of an organisation (`GET /stats/provider/{organizationId}`) are kept in memory |
| `health.mongoPingTimeoutMs` | integer | `1000` | |

## Logging

One JSON object per line on stdout when `logging.format` is `json`.

Access log, one line per request, with message `request completed`, or `request errored` and an `err` field when the response ended with an error. The usual pino fields (`time`, `pid`, `hostname`) are included.

| Field | Content |
|---|---|
| `level` | `info` below 400, `warn` for 4xx, `error` for 5xx |
| `req.id` | Request id |
| `req.method`, `req.url` | The URL carries the query string with `access_token`, `refresh_token`, `id_token`, `token`, `code`, `client_secret` and `password` replaced by `[Redacted]` |
| `req.clientIp` | The address Express resolved; `req.proxyIp` is added when the socket peer is a different address |
| `req.userAgent` | |
| `res.statusCode`, `res.contentLength` | |
| `responseTime` | Milliseconds |
| `partyId` | The authenticated party, when the request is authenticated |
| `api` | First segment of the proxied TMForum API path, when the request is proxied |

The request id is the value of the `X-Request-Id` request header when present, a UUID otherwise, and is returned
in the `X-Request-Id` response header. The `authorization` and `cookie` request headers and the `set-cookie`
response header are redacted in any logged object. The access log does not include request or response bodies.

## Outbound HTTPS

Certificates of outgoing HTTPS connections are verified. To trust a private certificate authority, mount the
PEM file and set `NODE_EXTRA_CA_CERTS` to its path.

### Feature switches

Each feature keeps its settings next to its `enabled` switch. The `feature-flags` document of the `config` collection
can override the switches only, with the names the admin API and the frontend use (`purchaseEnabled`,
`dspEnabled`, `tenderDevButtonsOpenCloseEnabled`...), and it is read every 5 seconds. A feature that the database
turns on while its settings are incomplete (for instance `dsp` without `dsp.contractDefinitionSchema`) stays off and
a warning is logged.

### Upstreams

The services the proxy calls are grouped in blocks. The `tmforum` block holds the TMForum APIs (`catalog`, `resource`,
`service`, `ordering`, `inventory`, `serviceInventory`, `resourceInventory`, `party`, `account`, `customer`,
`customerBill`, `usage`, `document`, `invoicing`, `software` and `quote`); `charging`, `revenue` and `search`
are standalone. Each API takes its own value for `host`, `port`, `scheme`, `path` and `timeoutMs` and, when it has none,
its group's; the timeout falls back to `upstreams.timeoutMs`. The URL is `<scheme>://<host>[:<port>]<path>`.

When every TMForum API runs on one server it is enough to set the group's host and port, since the paths of the
standard deployment are the defaults:

```yaml
upstreams:
  tmforum:
    host: tm-forum-api-svc
    port: 8080
    apis:
      quote:
        host: quote            # the one that runs elsewhere; the port is still 8080 unless it says otherwise
        port: 8085
        path: ""
```

There is no default host: an upstream the application needs and that resolves to no `host` is an error that names the
keys to set. The legacy `BAE_LP_ENDPOINT_*` variables keep working one API at a time, and the host or the port they
leave out comes from the group. An API that has any of them gets an empty path unless `PATH` says otherwise, as in
the legacy application, so a lone `PORT` also drops the default path of the API. Their names are crossed for two APIs:
`BAE_LP_ENDPOINT_BILLING_*` configures `account` and `BAE_LP_ENDPOINT_CUSTOMER_BILL_*` configures `customerBill`.

### Security

`security.*` and `http.cors.*` set, for the routes Nest serves and for what it hands to the legacy application:

- **Headers.** `X-Content-Type-Options`, `Strict-Transport-Security`, `Cross-Origin-*`, `Referrer-Policy` and a
  `Content-Security-Policy` that only reports until `security.csp.reportOnly` is `false`. `X-Powered-By` is removed.
- **CSRF.** A `POST`, `PUT`, `PATCH` or `DELETE` that the browser marks as cross-site (`Sec-Fetch-Site`, or a foreign
  `Origin`) is refused with 403. Reads, preflights and clients that are not browsers are not affected. When the portal
  runs on another origin in development (for instance `http://localhost:4200`), list it in
  `security.csrf.trustedOrigins`, as `BAE_SECURITY__CSRF__TRUSTED_ORIGINS='["http://localhost:4200"]'`; do not use it
  in production.
- **CORS.** Every origin is allowed until `http.cors.origins` says otherwise. The legacy application answers with its own
  `*` on the routes it serves.
- **Request body.** `http.bodyLimit` is `5mb`, enough for the file of the portal (up to 3 MB) as base64 in the body of an upload; the routes of the legacy application accept bodies of up to 50 MB.
- **Rate limiting** is not applied by the proxy.
