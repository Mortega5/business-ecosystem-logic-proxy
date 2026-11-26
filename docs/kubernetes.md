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
| Working directory | `config/default.yaml` is read relative to it, so it is the repository root; the compiled portal is read from `portal/bae-frontend`, above `dist/` |

The application serves the APIs and the compiled portal on the same port. A request that matches no route is the page
of the portal when a browser asks for it (it accepts HTML), so that a link into the portal opens directly, and a 404 for
anything else.

The image built from `docker/Dockerfile` runs `pnpm build` and its entrypoint ends with `exec node dist/main`, so
the process receiving `SIGTERM` is the Node.js one. Its `HEALTHCHECK` requests `/health/live` over HTTP, with a
start period of 120 seconds; with `app.https.enabled` set it needs to be overridden.

## HTTPS

Disabled by default. With `app.https.enabled` set to `true` the server listens on `app.port` over TLS and no longer
answers plain HTTP on that port. The key and
certificate files are read when the server starts; `app.https.keyFile` and `app.https.certFile` are required once
HTTPS is enabled and `app.https.caFile` is optional.

TLS 1.0 and 1.1 are excluded, and TLS 1.2 connections use this cipher list
(`ECDHE-RSA-AES256-SHA384:DHE-RSA-AES256-SHA384:ECDHE-RSA-AES256-SHA256:DHE-RSA-AES256-SHA256:ECDHE-RSA-AES128-SHA256:DHE-RSA-AES128-SHA256:HIGH`
without `aNULL`, `eNULL`, `EXPORT`, `DES`, `RC4`, `MD5`, `PSK`, `SRP` and `CAMELLIA`) in the server's order of preference.

With HTTPS enabled, the probes need `scheme: HTTPS`:

```yaml
livenessProbe:
  httpGet: { path: /health/live, port: 8004, scheme: HTTPS }
```

## Start-up

The server connects to MongoDB before it opens the port, and tries again with a growing delay (`mongo.retryInitialDelayMs`
up to `mongo.retryMaxDelayMs`) while it is not reachable. Progress is logged with `context: "Bootstrap"`:

| Level | Message | When |
|---|---|---|
| info | `Starting the server` | Immediately, with `port` and, when set, `host` |
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

Example configuration; the timings depend on how long MongoDB takes to be reachable:

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

1. `/health/ready` answers `503` with status `shutting_down`. On `SIGTERM` the server keeps accepting requests
   for `app.shutdownDelayMs` (no wait when it is `0`, and none for `SIGINT`); `/health/live` keeps answering `200`.
2. The HTTP server stops accepting connections and waits for the requests in flight to finish.
3. The MongoDB connection is closed.
4. The process exits with code 0.

Before the application is up (while it waits for MongoDB, for instance) there is nothing to drain: a signal ends the
process at once, and `docker/entrypoint.sh` does the same. As PID 1 a process
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
2. The [variables of version 11](#environment-variables-of-version-11) listed below.
3. The YAML file named by `CONFIG_FILE`, or `/etc/bae/config/application.yaml` when `CONFIG_FILE` is not set.
   The default file is optional; a file named by `CONFIG_FILE` must exist.
4. Environment variables named `BAE_<SECTION>__<KEY>`.

Environment variable names: `__` separates levels and a single `_` inside a level is a camelCase boundary, so
`BAE_MONGO__RETRY_MAX_DELAY_MS` is `mongo.retryMaxDelayMs`. Arrays and objects are given as JSON. Variables
without `__` after `BAE_` (the `BAE_LP_*` ones of version 11) are ignored by this mechanism.

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

### Environment variables of version 11

The `BAE_LP_*` variables of version 11 are read and translated to the keys of the configuration. A deprecation warning names the key that replaces each one in use:

| Variable | Configures | Variable that replaces it | Notes |
|---|---|---|---|
| `BAE_LP_PORT` | `app.port` | `BAE_APP__PORT` | Used while HTTPS is not enabled |
| `BAE_LP_HTTPS_ENABLED` | `app.https.enabled` | `BAE_APP__HTTPS__ENABLED` | Only the value `true` enables HTTPS |
| `BAE_LP_HTTPS_CERT`, `BAE_LP_HTTPS_KEY`, `BAE_LP_HTTPS_CA` | `app.https.certFile`, `app.https.keyFile`, `app.https.caFile` | `BAE_APP__HTTPS__CERT_FILE`, `BAE_APP__HTTPS__KEY_FILE`, `BAE_APP__HTTPS__CA_FILE` | |
| `BAE_LP_HTTPS_PORT` | `app.port` | `BAE_APP__PORT` | Used while HTTPS is enabled; `443` when it is not set |
| `BAE_LP_MONGO_SERVER`, `BAE_LP_MONGO_PORT`, `BAE_LP_MONGO_DB`, `BAE_LP_MONGO_USER`, `BAE_LP_MONGO_PASS` | `mongo.uri` | `BAE_MONGO__URI` | `mongodb://[user:password@]server:port/db`. Parts that are not set take the values of version 11: server `mongo`, port `27017`, database `belp`. Credentials are used only when both a user and a password are set, and are percent-encoded |
| `BAE_LP_CONTACT_US_NOTIFICATION_URL` | `upstreams.contactUs` | `BAE_UPSTREAMS__CONTACT_US` | Where the contact form is notified, as one URL (host, port, scheme and path are taken from it, the query is not); without it the form is notified to the charging backend. Also `BAE_UPSTREAMS__CONTACT_US__HOST` and the like |
| `BAE_GIT_HASH` | |  | Not configuration: the commit of the build, shown by `GET /version` |
| `BAE_DOME__ENABLED` | `dome.enabled` | `BAE_DOME__ENABLED` | Whether the DOME extension is part of the proxy. On by default; with `false` its routes do not exist. It has no pieces of its own yet, except that `/domeblog` is another name for `/blog` while it is on. v11 had no such variable |
| | `blog.enabled` (`BAE_BLOG__ENABLED`) | `BAE_BLOG__ENABLED` | Whether the blog, the news and the questions (`/blog`) are served. On by default; an administrator can switch it from the portal as any other feature (`blogEnabled` of `/config`) |
| `BAE_LP_ANALYTICS_ENABLED`, `BAE_LP_ANALYTICS_URL` | `analytics.enabled`, `analytics.url` | `BAE_ANALYTICS__ENABLED`, `BAE_ANALYTICS__URL` | Whether the dashboards of the analytics are offered (on unless `false`) and where Superset is (an http or https address). What an administrator saves from the portal (`PATCH /config/analytics`) wins over these |
| `BAE_LP_ANALYTICS_SUPERSET_GUEST_TOKEN_PATH` | `analytics.guestTokenPath` | `BAE_ANALYTICS__GUEST_TOKEN_PATH` | The path of the guest token endpoint of Superset (`/api/v1/dome/guest_token/` by default) |
| `BAE_LP_ANALYTICS_DASHBOARD_BUSINESS_INSIGHTS_NON_LEAR`, `..._BUSINESS_INSIGHTS_LEAR`, `..._USAGE_MONITOR` | `analytics.dashboards.businessInsightsNonLear`, `.businessInsightsLear`, `.usageMonitor` | `BAE_ANALYTICS__DASHBOARDS__BUSINESS_INSIGHTS_NON_LEAR`, `BAE_ANALYTICS__DASHBOARDS__BUSINESS_INSIGHTS_LEAR`, `BAE_ANALYTICS__DASHBOARDS__USAGE_MONITOR` | The ids of the dashboards: the business one for users, the one for organisation administrators, and the usage monitor for administrators |
| | `analytics.timeoutMs` | `BAE_ANALYTICS__TIMEOUT_MS` | Longest time to wait for Superset (10 seconds by default; v11 had no limit) |
| `BAE_LP_COMPLIANCE_SERVER_URL` | `compliance.serverUrl` | `BAE_COMPLIANCE__SERVER_URL` | The compliance service that a seller asks for the certificate of a product (`POST /compliance/certificate`); without it that route answers 503. |
| | `compliance.enabled` (`BAE_COMPLIANCE__ENABLED`) | `BAE_COMPLIANCE__ENABLED` | Whether the check of the compliance and the upload of the credential of a product (`POST /compliance/certificate`, `PATCH /admin/uploadcertificate/{specId}`) are served. On by default; an administrator can switch it from the portal (`complianceEnabled` of `/config`) |
| | `compliance.timeoutMs`, `.maxFiles`, `.maxFileMb`, `.fileOrigins` | `BAE_COMPLIANCE__TIMEOUT_MS`, `BAE_COMPLIANCE__MAX_FILES`, `BAE_COMPLIANCE__MAX_FILE_MB`, `BAE_COMPLIANCE__FILE_ORIGINS` | How long to wait for the compliance service (120000 ms), how many files a request may carry (20), how big each is (20 MB) and the origins they may be at, as a JSON list (`["https://files.example.org"]`; empty means any public address). `BAE_COMPLIANCE__*` sets them |
| `BAE_LP_DATASETS_ENABLED`, `BAE_LP_API_ACCESS_ENABLED` | `datasets.enabled`, `apiAccess.enabled` | `BAE_DATASETS__ENABLED`, `BAE_API_ACCESS__ENABLED` | Whether the portal can offer datasets and APIs for sale. They start off, and an administrator can switch them from the portal; only `true` turns them on |
| `BAE_LP_BLUEPRINTS_ENABLED`, `BAE_LP_SOFTWARE_ENABLED` | `blueprints.enabled`, `software.enabled` | `BAE_BLUEPRINTS__ENABLED`, `BAE_SOFTWARE__ENABLED` | Whether the portal offers blueprints and software. They start on; only `false` turns them off |
| `BAE_LP_FILE_SERVICE_ENABLED` | `fileService.enabled` | `BAE_FILE_SERVICE__ENABLED` | Whether a file service is deployed; a dataset can be made from a file only when it is (`datasetFilesEnabled` of `/config`) |
| `BAE_LP_FILE_SERVICE_URL`, `BAE_LP_FILE_SERVICE_TOKEN` | `fileService.url`, `fileService.token` | `BAE_FILE_SERVICE__URL`, `BAE_FILE_SERVICE__TOKEN` | The address of the file service (`http://file-service:8081` by default) and the token with which the proxy calls it |
| `BAE_LP_FILE_SERVICE_TIMEOUT` | `fileService.timeoutMs` | `BAE_FILE_SERVICE__TIMEOUT_MS` | Longest time for one request to the file service, in ms (30 minutes by default: an upload takes a while) |
| `BAE_LP_FILE_SERVICE_MAX_SIZE_MB`, `BAE_LP_FILE_SERVICE_ACCEPTED_TYPES` | `fileService.maxSizeMb`, `fileService.acceptedTypes` | `BAE_FILE_SERVICE__MAX_SIZE_MB`, `BAE_FILE_SERVICE__ACCEPTED_TYPES` | The largest file (100 by default) and the types the portal offers (`.csv,.json,text/csv,application/json`), as the `accept` of a file input. `/config` gives them as `datasetMaxSizeBytes` and `datasetAcceptedTypes` |
| `BAE_LP_PURCHASE_ENABLED`, `BAE_LP_DATASPACE_ENABLED`, `BAE_LP_CATALOG_MANAGEMENT_ENABLED`, `BAE_LP_DSP_ENABLED`, `BAE_LP_QUOTE_ENABLED`, `BAE_LP_TENDERING_ENABLED`, `BAE_LP_LAUNCH_VALIDATION_ENABLED` | `purchase.enabled`, `dataSpace.enabled`, `catalogManagement.enabled`, `dsp.enabled`, `quotes.enabled`, `tendering.enabled`, `launchValidation.enabled` | `BAE_PURCHASE__ENABLED`, `BAE_DATA_SPACE__ENABLED`, `BAE_CATALOG_MANAGEMENT__ENABLED`, `BAE_DSP__ENABLED`, `BAE_QUOTES__ENABLED`, `BAE_TENDERING__ENABLED`, `BAE_LAUNCH_VALIDATION__ENABLED` | Anything other than `true` turns the feature off |
| `BAE_LP_TENDER_DEV_BUTTON_ENABLED` | `tendering.devButtonsOpenClose` | `BAE_TENDERING__DEV_BUTTONS_OPEN_CLOSE` | Same rule |
| `BAE_LP_PAYMENT_GATEWAY`, `BAE_LP_PAYMENT_PROVIDER` | `purchase.paymentGateway`, `purchase.paymentProvider` | `BAE_PURCHASE__PAYMENT_GATEWAY`, `BAE_PURCHASE__PAYMENT_PROVIDER` | The provider is trimmed and lowercased; blank means `none` |
| `BAE_LP_CHAT_URL`, `BAE_LP_KNOWLEDGE_BASE_URL`, `BAE_LP_TICKETING_URL`, `BAE_LP_MATOMO_ID`, `BAE_LP_MATOMO_URL`, `BAE_LP_GOOGLE_TAG_MANAGER_ID`, `BAE_LP_THEME` | `portal.chatUrl`, `portal.knowledgeBaseUrl`, `portal.ticketingUrl`, `portal.matomoId`, `portal.matomoUrl`, `portal.googleTagManagerId`, `portal.theme` | `BAE_PORTAL__CHAT_URL`, `BAE_PORTAL__KNOWLEDGE_BASE_URL`, `BAE_PORTAL__TICKETING_URL`, `BAE_PORTAL__MATOMO_ID`, `BAE_PORTAL__MATOMO_URL`, `BAE_PORTAL__GOOGLE_TAG_MANAGER_ID`, `BAE_PORTAL__THEME` | |
| TO REMOVE: `BAE_LP_DOME_TRUST`, `BAE_LP_DOME_ABOUT`, `BAE_LP_DOME_REGISTER`, `BAE_LP_DOME_REGISTER_CUSTOMER`, `BAE_LP_DOME_REGISTRATION_FORM`, `BAE_LP_DOME_ONBOARDING_GUIDELINES`, `BAE_LP_DOME_GUIDELINES`, `BAE_LP_DOME_PUBLISH`, `BAE_LP_LEAR_URL` | `portal.extra.domeTrust`, `domeAbout`, `domeRegister`, `domeRegisterCustomer` (the register link when it has none of its own), `domeRegistrationForm`, `domeOnboardingGuidelines`, `domeGuidelines`, `domePublish` and `learUrl` | `BAE_PORTAL__EXTRA__DOME_TRUST`, `BAE_DOME_ABOUT`, `BAE_DOME_REGISTER`, `BAE_DOME_REGISTER_CUSTOMER`, `BAE_DOME_REGISTRATION_FORM`, `BAE_DOME_ONBOARDING_GUIDELINES`, `BAE_DOME_GUIDELINES`, `BAE_DOME_PUBLISH`, `BAE_LEAR_URL`, `BAE_ROLES__CERTIFIER` | Kept so that a deployment of v11 goes on working, and to be removed: set the keys in `portal.extra`. Without the variable the address that v11 gave by default is used for `domeAbout`, `domeRegister` (and so `domeRegisterCustomer`) and `domePublish`, unless `portal.extra` sets it |
| `BAE_LP_QUOTE_API` | `quotes.api` | `BAE_QUOTES__API` | |
| `BAE_LP_DSP_CONTRACT_DEFINITION_SCHEMA` | `dsp.contractDefinitionSchema` | `BAE_DSP__CONTRACT_DEFINITION_SCHEMA` | |
| `BAE_LP_OFFERING_SCHEMA`, `BAE_LP_PRICE_COMP_SCHEMA`, `BAE_LP_BLUEPRINT_SCHEMA`, `BAE_LP_PARTY_LOCATION` | `catalog.offeringSchema`, `catalog.priceCompSchema`, `catalog.blueprintSchema`, `catalog.partyLocation` | `BAE_CATALOG__OFFERING_SCHEMA`, `BAE_CATALOG__PRICE_COMP_SCHEMA`, `BAE_CATALOG__BLUEPRINT_SCHEMA`, `BAE_CATALOG__PARTY_LOCATION` | |
| `BAE_LP_DEFAULT_CATALOG_ID`, `BAE_LP_DEFAULT_CATALOG_NAME` | `catalog.defaultCatalogId`, `catalog.defaultCatalogName` | `BAE_CATALOG__DEFAULT_CATALOG_ID`, `BAE_CATALOG__DEFAULT_CATALOG_NAME` | |
| `BAE_LP_CORS_EXPOSE_REDIRECT` | `http.cors.exposeRedirect` | `BAE_HTTP__CORS__EXPOSE_REDIRECT` | Anything other than `true` turns it off |
| `BAE_LP_PROPAGATE_TOKEN`, `BAE_LP_ALLOW_LOCAL_EORI` | `auth.propagateToken`, `auth.allowLocalEori` | `BAE_AUTH__PROPAGATE_TOKEN`, `BAE_AUTH__ALLOW_LOCAL_EORI` | Anything other than `true` turns the option off |
| `BAE_LP_OPERATOR_ID` | `operator.id` | `BAE_OPERATOR__ID` | The organisation that operates the marketplace; empty means there is none |
| `BAE_LP_OAUTH2_ADMIN_ROLE`, `_SELLER_ROLE`, `_CUSTOMER_ROLE`, `_ORG_ADMIN_ROLE`, `_ORG_CERTIFIER_ROLE` | `auth.roles.admin`, `.seller`, `.customer`, `.orgAdmin`, `.certifier` | `BAE_AUTH__ROLES__ADMIN`, `BAE_AUTH__ROLES__SELLER`, `BAE_AUTH__ROLES__CUSTOMER`, `BAE_AUTH__ROLES__ORG_ADMIN`, `BAE_AUTH__ROLES__CERTIFIER` | |
| `BAE_LP_ENDPOINT_<NAME>_HOST`, `_PORT`, `_PATH`, `_SECURED` | `upstreams.tmforum.apis.<api>` or `upstreams.<name>` | `BAE_UPSTREAMS__TMFORUM__APIS__<API>`, `BAE_UPSTREAMS__<NAME>` | See [Upstreams](#upstreams) for the names. `SECURED=true` sets `scheme: https`. What is not set (host or port) comes from the group; a missing `PATH` means the path version 11 had for that endpoint, which is empty except for `revenue` (`/revenue`) and `invoicing` (`/invoicing`) |

When none of the `BAE_LP_MONGO_*` variables is set, the default address applies (see `mongo.*` below).

Each variable in use is logged at start-up, with `context: "Bootstrap"`:

| Level | Message | Fields |
|---|---|---|
| warn | `Deprecated environment variable, still applied` | `variable`, `key` (the configuration key it sets) and `replacement` (the `BAE_<SECTION>__<KEY>` name) |

### Keys

Keys read by the application:

| Key | Environment variable | Type | Default | |
|---|---|---|---|---|
| `app.host` | `BAE_APP__HOST` | string | not set | Listening address |
| `app.port` | `BAE_APP__PORT` | integer 1–65535 | `8004` | Listening port |
| `app.https.enabled` | `BAE_APP__HTTPS__ENABLED` | boolean | `false` | Serves HTTPS instead of HTTP |
| `app.https.keyFile`, `app.https.certFile` | `BAE_APP__HTTPS__KEY_FILE`, `BAE_APP__HTTPS__CERT_FILE` | string | not set | PEM files; required when `app.https.enabled` is `true` |
| `app.https.caFile` | `BAE_APP__HTTPS__CA_FILE` | string | not set | PEM file with the certificate authority chain |
| `app.shutdownDelayMs` | `BAE_APP__SHUTDOWN_DELAY_MS` | integer ≥ 0 | `0` | Time the server keeps accepting requests, with readiness at 503, after `SIGTERM` |
| `app.shutdownTimeoutMs` | `BAE_APP__SHUTDOWN_TIMEOUT_MS` | integer, greater than `app.shutdownDelayMs` | `20000` | Maximum duration of the shutdown |
| `logging.level` | `BAE_LOGGING__LEVEL` | `fatal` `error` `warn` `info` `debug` `trace` `silent` | `info` | |
| `logging.format` | `BAE_LOGGING__FORMAT` | `json` `pretty` | `pretty` | `pretty` uses pino-pretty |
| `logging.prettyOptions` | `BAE_LOGGING__PRETTY_OPTIONS` | object | `{ singleLine: true }` | Options for pino-pretty |
| `mongo.uri` | `BAE_MONGO__URI` | string | not set | The whole address (`mongodb://[user:password@]host[:port][,host...]/database[?options]`). The only way to give the options of the connection, such as a replica set or TLS. It cannot be given together with any of the parts below |
| `mongo.host`, `.port`, `.database` | `BAE_MONGO__HOST`, `BAE_MONGO__PORT`, `BAE_MONGO__DATABASE` | string, integer 1–65535, string | `localhost`, `27017`, `belp` | The address, in parts, when there is no `mongo.uri` |
| `mongo.user`, `.password` | `BAE_MONGO__USER`, `BAE_MONGO__PASSWORD` | string | not set | The credentials, which go together. They are given to the connection as they are, not in the address, so they need no encoding and are not in the log |
| `mongo.authSource` | `BAE_MONGO__AUTH_SOURCE` | string | the database | The database the user is authenticated against (`admin` in most deployments) |
| `mongo.maxPoolSize` | `BAE_MONGO__MAX_POOL_SIZE` | integer | `10` | |
| `mongo.serverSelectionTimeoutMs` | `BAE_MONGO__SERVER_SELECTION_TIMEOUT_MS` | integer | `5000` | How long each connection attempt waits for a server |
| `mongo.heartbeatFrequencyMs` | `BAE_MONGO__HEARTBEAT_FREQUENCY_MS` | integer ≥ 500 | `10000` | |
| `mongo.retryInitialDelayMs` | `BAE_MONGO__RETRY_INITIAL_DELAY_MS` | integer | `1000` | |
| `mongo.retryMaxDelayMs` | `BAE_MONGO__RETRY_MAX_DELAY_MS` | integer | `30000` | |
| `http.uploadLimit` | `BAE_HTTP__UPLOAD_LIMIT` | size | `50mb` | Largest file upload (multipart body) a route accepts; a bigger one is refused with 413 |
| `http.trustedProxies` | `BAE_HTTP__TRUSTED_PROXIES` | list of addresses | `[]` | Proxies whose `X-Forwarded-For` is believed to know the address of the client; none means it is never believed |
| `http.bodyLimit` | `BAE_HTTP__BODY_LIMIT` | size | `5mb` | Largest body a route that reads one accepts; a bigger one is refused with 413 |
| `http.cors.origins` | `BAE_HTTP__CORS__ORIGINS` | list of origins or `"*"` | `["*"]` | Origins that may call the API from a browser; `*` is what version 11 did |
| `http.cors.exposeRedirect` | `BAE_HTTP__CORS__EXPOSE_REDIRECT` | boolean | `false` | Exposes `X-Redirect-URL` to the browser |
| `security.csp.reportOnly` | `BAE_SECURITY__CSP__REPORT_ONLY` | boolean | `true` | Sends `Content-Security-Policy-Report-Only` instead of enforcing the policy |
| `security.hsts.enabled`, `.maxAgeSeconds`, `.includeSubDomains` | `BAE_SECURITY__HSTS__ENABLED`, `BAE_SECURITY__HSTS__MAX_AGE_SECONDS`, `BAE_SECURITY__HSTS__INCLUDE_SUB_DOMAINS` | boolean, integer, boolean | `true`, `31536000`, `false` | `Strict-Transport-Security`; browsers ignore it over plain HTTP |
| `security.crossOriginResourcePolicy` | `BAE_SECURITY__CROSS_ORIGIN_RESOURCE_POLICY` | `same-origin` `same-site` `cross-origin` | `same-origin` | |
| `security.csrf.enabled` | `BAE_SECURITY__CSRF__ENABLED` | boolean | `true` | Refuses state-changing requests a browser says come from another site |
| `security.csrf.trustedOrigins` | `BAE_SECURITY__CSRF__TRUSTED_ORIGINS` | list of origins | `[]` | Origins exempt from that check; meant for tests and development |
| `auth.propagateToken` | `BAE_AUTH__PROPAGATE_TOKEN` | boolean | `true` | Sends the user's access token to the upstreams as `Authorization: Bearer` |
| `auth.allowLocalEori` | `BAE_AUTH__ALLOW_LOCAL_EORI` | boolean | `false` | A local IdP user acts under their display name as IdP id |
| `auth.roles.admin`, `.customer`, `.seller`, `.orgAdmin`, `.certifier` | `BAE_AUTH__ROLES__ADMIN`, `BAE_AUTH__ROLES__CUSTOMER`, `BAE_AUTH__ROLES__SELLER`, `BAE_AUTH__ROLES__ORG_ADMIN`, `BAE_AUTH__ROLES__CERTIFIER` | string | `admin`, `Buyer`, `Seller`, `orgAdmin`, `certifier` | Names of the roles in the identity provider. Whoever has the certifier role, besides the administrators, uploads the compliance credential of a product |
| `purchase.enabled` | `BAE_PURCHASE__ENABLED` | boolean | `true` | |
| `purchase.paymentProvider` | `BAE_PURCHASE__PAYMENT_PROVIDER` | `dpas` `paypal` `stripe` `none` | `none` | |
| `purchase.paymentGateway` | `BAE_PURCHASE__PAYMENT_GATEWAY` | URL | not set | Required when the provider is `dpas`; there is no default |
| `quotes.enabled` | `BAE_QUOTES__ENABLED` | boolean | `true` | |
| `quotes.api` | `BAE_QUOTES__API` | string | `/quote/quoteManagement` | |
| `tendering.enabled` | `BAE_TENDERING__ENABLED` | boolean | `true` | |
| `tendering.devButtonsOpenClose` | `BAE_TENDERING__DEV_BUTTONS_OPEN_CLOSE` | boolean | `false` | |
| `dsp.enabled` | `BAE_DSP__ENABLED` | boolean | `false` | |
| `dsp.contractDefinitionSchema` | `BAE_DSP__CONTRACT_DEFINITION_SCHEMA` | URL | the `contract-definition.json` of `wistefan/edc-dsc` (branch `init`) | The schema of the EDC contract definition that the portal puts in the offers that use the data space. v11 gave here the schema of the deployment of software by mistake |
| `launchValidation.enabled`, `dataSpace.enabled` | `BAE_LAUNCH_VALIDATION__ENABLED`, `BAE_DATA_SPACE__ENABLED` | boolean | `false` | |
| `catalogManagement.enabled` | `BAE_CATALOG_MANAGEMENT__ENABLED` | boolean | `true` | |
| `catalog.offeringSchema`, `catalog.priceCompSchema`, `catalog.blueprintSchema`, `catalog.partyLocation` | `BAE_CATALOG__OFFERING_SCHEMA`, `BAE_CATALOG__PRICE_COMP_SCHEMA`, `BAE_CATALOG__BLUEPRINT_SCHEMA`, `BAE_CATALOG__PARTY_LOCATION` | URL | the values of version 11 | `@schemaLocation` of offerings, price components, blueprint product specifications and the related parties of what the operator owns |
| `catalog.defaultCatalogId` | `BAE_CATALOG__DEFAULT_CATALOG_ID` | string | empty | The default catalog, which lists the root categories the marketplace shows; when it is set it is the one used and it has to exist. When it is empty the proxy takes the stored one, the one the catalog API marks with the catalog type `default`, or makes one |
| `catalog.defaultCatalogName` | `BAE_CATALOG__DEFAULT_CATALOG_NAME` | string | `default` | The name of the default catalog the proxy makes, and with which it recognises the one made before the catalog type existed |
| `catalog.bootstrap.enabled` | `BAE_CATALOG__BOOTSTRAP__ENABLED` | boolean | `true` | Whether the proxy makes sure, every time it starts, of the default catalog, the system categories (in the default catalog) and the support package spec of the software. Off, it does nothing and what is not there is not made; the default catalog is then the one of `catalog.defaultCatalogId`, if any |
| `catalog.bootstrap.retryDelayMs` | `BAE_CATALOG__BOOTSTRAP__RETRY_DELAY_MS` | integer | `5000` | The wait before the start-up tries again when the TMForum APIs do not answer |
| `catalog.bootstrap.records.defaultCatalog`, `catalog.bootstrap.records.supportPackageSpec` | `BAE_CATALOG__BOOTSTRAP__RECORDS__DEFAULT_CATALOG`, `BAE_CATALOG__BOOTSTRAP__RECORDS__SUPPORT_PACKAGE_SPEC` | string | `default`, `global` | The ids of the records (in `defaultcatalog` and `supportpackagespec`) in which the start-up keeps what it found. They are the ones of v11: changing them leaves what it stored unread, and it looks for it again |
| `catalog.systemCategories` | `BAE_CATALOG__SYSTEM_CATEGORIES` | list of `key`, `name`, `description` | `dataset`, `api`, `blueprint` | The categories of the platform, one per kind of product; the proxy makes them, adds them to the default catalog, and does not let them be retired, renamed or moved. A catalog cannot be named as one of them |
| `upstreams.timeoutMs` | `BAE_UPSTREAMS__TIMEOUT_MS` | integer | `30000` | Timeout of every upstream that does not set its own |
| `upstreams.tmforum.host`, `.port`, `.scheme` | `BAE_UPSTREAMS__TMFORUM__HOST`, `BAE_UPSTREAMS__TMFORUM__PORT`, `BAE_UPSTREAMS__TMFORUM__SCHEME` | string, integer, `http` `https` | not set (`http` when no scheme is given) | Default server of every TMForum API |
| `upstreams.tmforum.apis.<api>.host`, `.port`, `.scheme`, `.path`, `.timeoutMs` | `BAE_UPSTREAMS__TMFORUM__APIS__<API>__HOST`, `__PORT`, `__SCHEME`, `__PATH`, `__TIMEOUT_MS`, with `<API>` the name of the API in upper snake case (`CUSTOMER_BILL`) | | the standard TMForum paths | What one API sets itself; see [Upstreams](#upstreams) |
| `upstreams.charging`, `.revenue`, `.search` | `BAE_UPSTREAMS__<NAME>__HOST`, `__PORT`, `__SCHEME`, `__PATH`, `__TIMEOUT_MS`, with `<NAME>` as `CHARGING`, `REVENUE` or `SEARCH` | `host`, `port`, `scheme`, `path`, `timeoutMs` | not set (`charging.port` is `8006` and `revenue.path` is `/revenue`) | The services that are not TMForum APIs |
| `limits.orderItems` | `BAE_LIMITS__ORDER_ITEMS` | integer | `50` | Items that one product order may have |
| `limits.cartItems` | `BAE_LIMITS__CART_ITEMS` | integer | `100` | Items that the shopping cart of a user may hold |
| `limits.noteLength`, `limits.notesPerRequest` | `BAE_LIMITS__NOTE_LENGTH`, `BAE_LIMITS__NOTES_PER_REQUEST` | integer | `10000`, `20` | Characters of a note of an order, and notes that one request adds |
| `limits.nameLength`, `limits.descriptionLength` | `BAE_LIMITS__NAME_LENGTH`, `BAE_LIMITS__DESCRIPTION_LENGTH` | integer | `100`, `100000` | Characters of the name and of the description of a specification or a category |
| `limits.plansPerQuery` | `BAE_LIMITS__PLANS_PER_QUERY` | integer | `20` | Price plans that one query to the catalog asks for, when the proxy looks for the offers that use a usage specification |
| `limits.providersPerQuery`, `limits.providerCacheMs` | `BAE_LIMITS__PROVIDERS_PER_QUERY`, `BAE_LIMITS__PROVIDER_CACHE_MS` | integer | `50`, `300000` | The directory of providers, when the marketplace has no search engine: the organisations that one query to the party API asks for, and the milliseconds that the organisations with launched offerings are kept before they are looked for again |
| `limits.readAll.pageSize`, `limits.readAll.maxPages` | `BAE_LIMITS__READ_ALL__PAGE_SIZE`, `BAE_LIMITS__READ_ALL__MAX_PAGES` | integer | `100`, `100` | When the proxy reads everything that a TMForum collection has (what uses a specification, the catalogs of the start-up): the items it asks for in a page, and the pages it reads at most before it gives up |
| `portal.chatUrl`, `portal.knowledgeBaseUrl`, `portal.ticketingUrl`, `portal.matomoId`, `portal.matomoUrl`, `portal.googleTagManagerId`, `portal.theme` | `BAE_PORTAL__CHAT_URL`, `BAE_PORTAL__KNOWLEDGE_BASE_URL`, `BAE_PORTAL__TICKETING_URL`, `BAE_PORTAL__MATOMO_ID`, `BAE_PORTAL__MATOMO_URL`, `BAE_PORTAL__GOOGLE_TAG_MANAGER_ID`, `BAE_PORTAL__THEME` | string | empty | What `GET /config` sends to the portal as `chat`, `knowledgeBaseUrl`, `ticketingUrl`, `matomoId`, `matomoUrl`, `googleTagManagerId` and `theme` |
| `portal.extra` | `BAE_PORTAL__EXTRA` | mapping | `{}` | Anything else that `GET /config` sends, as it is and to every visitor, so nothing secret goes in it. A key that the proxy sets itself (`roles`, `chat`, `defaultId`...) is not taken from it, except that an object such as `roles` is completed with the keys that it has. By variable: `BAE_PORTAL__EXTRA` with a JSON text, or one by one with `BAE_PORTAL__EXTRA__DOME_ABOUT` for `domeAbout` |
| `stats.ttlMs`, `stats.retryDelayMs` | `BAE_STATS__TTL_MS`, `BAE_STATS__RETRY_DELAY_MS` | integer | `86400000`, `600000` | The figures of the landing page (`GET /stats`): the milliseconds that they are kept in Mongo before a request makes the proxy read them again, in the background (the request is answered with what is kept), and the ones to wait before trying again when that read failed |
| `stats.providerTtlMs` | `BAE_STATS__PROVIDER_TTL_MS` | integer | `60000` | The milliseconds that the counts of an organisation (`GET /stats/provider/{organizationId}`) are kept in memory |
| `health.mongoPingTimeoutMs` | `BAE_HEALTH__MONGO_PING_TIMEOUT_MS` | integer | `1000` | |

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
turns on while its settings are incomplete (none is today, as every setting has a default; the check is for a setting that is given none) stays off and
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
keys to set. The `BAE_LP_ENDPOINT_*` variables of version 11 keep working one API at a time, and the host or the port they
leave out comes from the group. An API that has any of them gets an empty path unless `PATH` says otherwise, as in
version 11, so a lone `PORT` also drops the default path of the API. Their names are crossed for two APIs:
`BAE_LP_ENDPOINT_BILLING_*` configures `account` and `BAE_LP_ENDPOINT_CUSTOMER_BILL_*` configures `customerBill`.

### Security

`security.*` and `http.cors.*` set, for every route:

- **Headers.** `X-Content-Type-Options`, `Strict-Transport-Security`, `Cross-Origin-*`, `Referrer-Policy` and a
  `Content-Security-Policy` that only reports until `security.csp.reportOnly` is `false`. `X-Powered-By` is removed.
- **CSRF.** A `POST`, `PUT`, `PATCH` or `DELETE` that the browser marks as cross-site (`Sec-Fetch-Site`, or a foreign
  `Origin`) is refused with 403. Reads, preflights and clients that are not browsers are not affected. When the portal
  runs on another origin in development (for instance `http://localhost:4200`), list it in
  `security.csrf.trustedOrigins`, as `BAE_SECURITY__CSRF__TRUSTED_ORIGINS='["http://localhost:4200"]'`; do not use it
  in production.
- **CORS.** Every origin is allowed until `http.cors.origins` says otherwise.
- **Request body.** `http.bodyLimit` is `5mb`, enough for the file of the portal (up to 3 MB) as base64 in the body of an upload.
- **Rate limiting** is not applied by the proxy.
