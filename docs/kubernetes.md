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

The image built from `docker/Dockerfile` starts `server.js` on its own, so the endpoints in this document
exist only when the container runs `dist/main`.

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
| `BAE_LP_PORT` | `app.port` | |
| `BAE_LP_MONGO_SERVER`, `BAE_LP_MONGO_PORT`, `BAE_LP_MONGO_DB`, `BAE_LP_MONGO_USER`, `BAE_LP_MONGO_PASS` | `mongo.uri` | `mongodb://[user:password@]server:port/db`. Parts that are not set take the values of the legacy application: server `mongo`, port `27017`, database `belp`. Credentials are used only when both a user and a password are set, and are percent-encoded |

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
