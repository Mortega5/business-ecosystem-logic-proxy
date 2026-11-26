# Metrics

Reference of the metrics that the proxy exposes in the Prometheus text format. How to turn them on, the port and the
configuration keys are in [kubernetes.md](kubernetes.md#metrics).

`metrics.prefix` (`bae_proxy` by default) goes, followed by an underscore, before the name of the metrics of the proxy.
The names below are written with the default prefix. The metrics of the process keep their standard names.

## HTTP requests

| Metric | Type | Labels | Unit |
|---|---|---|---|
| `bae_proxy_http_server_request_duration_seconds` | histogram | `method`, `route`, `status_class` | seconds |

The time between a request arriving and its response being sent, for every request that is answered. It gives the rate
(`_count`), the duration (`_sum` and `_bucket`) and, by `status_class`, the errors. A request that the client aborts
before the response ends is not recorded.

| Label | Values |
|---|---|
| `method` | The HTTP method: `GET`, `POST`... |
| `route` | The template of the route that answered, such as `/catalog/productOffering/:id`, never the URL. `unmatched` when no route answered: the files of the portal and the paths that do not exist |
| `status_class` | `1xx`, `2xx`, `3xx`, `4xx` or `5xx` |

The buckets are `metrics.httpDurationBuckets`, in seconds.

Examples:

```promql
# Requests per second, by route
sum by (route) (rate(bae_proxy_http_server_request_duration_seconds_count[5m]))

# Share of the requests that fail on the server
sum(rate(bae_proxy_http_server_request_duration_seconds_count{status_class="5xx"}[5m]))
  / sum(rate(bae_proxy_http_server_request_duration_seconds_count[5m]))

# 95th percentile of the duration, by route
histogram_quantile(0.95, sum by (le, route) (rate(bae_proxy_http_server_request_duration_seconds_bucket[5m])))
```

## Calls to third parties

| Metric | Type | Labels | Unit |
|---|---|---|---|
| `bae_proxy_upstream_request_duration_seconds` | histogram | `upstream`, `method`, `outcome` | seconds |

The time taken by every call that the proxy makes to a service it depends on: the TMForum APIs, the charging backend,
the billing engine, the search service, and the payment, compliance, file and analytics services.

| Label | Values |
|---|---|
| `upstream` | The name of the service, such as `tmforum` or `charging`; never its address |
| `method` | The HTTP method of the call |
| `outcome` | The class of the status of the answer (`2xx`...`5xx`), `timeout` when it did not answer in time, or `network` when it could not be reached |

The buckets are `metrics.upstreamDurationBuckets`, in seconds. The calls that the proxy makes to the identity provider
while a user logs in are not included.

```promql
# Share of the calls to each service that fail
sum by (upstream) (rate(bae_proxy_upstream_request_duration_seconds_count{outcome=~"5xx|timeout|network"}[5m]))
  / sum by (upstream) (rate(bae_proxy_upstream_request_duration_seconds_count[5m]))
```

## Authentication

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `bae_proxy_auth_failures_total` | counter | `status`, `api` | Requests answered `401` or `403`. `api` is the first segment of the route, such as `catalog`, and `unmatched` for no route |
| `bae_proxy_login_total` | counter | `provider`, `result` | Logins that ended. `provider` is the identity provider, or `vc` for a login with a credential; `result` is `success` or `failure` |
| `bae_proxy_profile_cache_total` | counter | `result` | Requests whose token had its profile kept (`hit`) or had to be asked for (`miss`) |

## State of the process

| Metric | Type | Meaning |
|---|---|---|
| `bae_proxy_draining` | gauge | `1` once the shutdown has started and the process stops taking traffic, `0` before |
| `bae_proxy_mongo_up` | gauge | `1` when MongoDB answered the last readiness check, `0` when it did not. It has no value until the first check, so it needs the readiness probe |
| `bae_proxy_stats_refresh_total` | counter | Reads of the figures of the landing page (`result` is `success` or `failure`) |

## Process and Node.js

Present while `metrics.defaultMetrics` is on. They come from the Prometheus client library and keep its standard
names, which the community dashboards of Node.js expect, so `metrics.prefix` does not apply to them. The complete list
depends on the version of the library and on the platform: the ones about file descriptors and memory exist only on
Linux. See the documentation of [`@prometheus-io/client`](https://github.com/prometheus/client_js#default-metrics).

| Metric | Type | Meaning |
|---|---|---|
| `process_cpu_user_seconds_total`, `process_cpu_system_seconds_total` | counter | CPU time used in user and system mode |
| `process_resident_memory_bytes` | gauge | Resident memory of the process |
| `process_open_fds`, `process_max_fds` | gauge | File descriptors that are open, and the limit |
| `process_start_time_seconds` | gauge | When the process started, in Unix time; it tells restarts |
| `nodejs_eventloop_lag_seconds` | gauge | Delay of the event loop; high values mean the process cannot keep up |
| `nodejs_heap_size_used_bytes`, `nodejs_heap_size_total_bytes` | gauge | Heap of V8 that is used, and reserved |
| `nodejs_gc_duration_seconds` | histogram | Duration of the garbage collections, by kind |
| `nodejs_active_handles`, `nodejs_active_requests` | gauge | Handles and requests that keep the event loop busy |
| `nodejs_version_info` | gauge | Version of Node.js, in its labels |
