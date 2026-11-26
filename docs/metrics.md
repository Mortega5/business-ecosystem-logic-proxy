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
| `route` | The template of the route that answered, such as `/catalog/productOffering/:id`, never the URL. `/*path`, the catch-all of the portal, for the files of the portal and the paths that do not exist; `unmatched` if a request ends with no route at all |
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
| `upstream` | The name of the service, such as `charging`, or `tmforum.<api>` for each TMForum API (`tmforum.catalog`, `tmforum.ordering`...); never its address |
| `method` | The HTTP method of the call |
| `outcome` | The class of the status of the answer (`2xx`...`5xx`), `timeout` when it did not answer in time, or `network` when it could not be reached |

The buckets are `metrics.upstreamDurationBuckets`, in seconds. The calls that the proxy makes to identity providers (the
token and user information endpoints, the discovery document and the signing keys) are all counted under `upstream="idp"`,
whichever provider they go to, since an administrator can add providers while the server runs.

```promql
# Share of the calls to each service that fail
sum by (upstream) (rate(bae_proxy_upstream_request_duration_seconds_count{outcome=~"5xx|timeout|network"}[5m]))
  / sum by (upstream) (rate(bae_proxy_upstream_request_duration_seconds_count[5m]))
```

## Authentication

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `bae_proxy_auth_failures_total` | counter | `status`, `api` | Requests answered `401` or `403`. `api` is the first segment of the route, such as `catalog`, `*path` for the catch-all of the portal, and `unmatched` for no route |
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
names, which the community dashboards of Node.js expect, so `metrics.prefix` does not apply to them. They do not depend
on the requests the proxy receives. The complete list depends on the version of the library and on the platform; see
the documentation of [`@prometheus-io/client`](https://github.com/prometheus/client_js#default-metrics).

| Metric | Type | Meaning |
|---|---|---|
| `process_cpu_user_seconds_total`, `process_cpu_system_seconds_total`, `process_cpu_seconds_total` | counter | CPU time used in user mode, in system mode, and in total |
| `process_start_time_seconds` | gauge | When the process started, in Unix time; it tells restarts |
| `process_resident_memory_bytes` | gauge | Resident memory of the process |
| `process_virtual_memory_bytes`, `process_heap_bytes` | gauge | Virtual memory and heap of the process. Linux only |
| `process_open_fds`, `process_max_fds` | gauge | File descriptors that are open, and the limit. Linux only |
| `nodejs_eventloop_lag_seconds` | gauge | Delay of the event loop, read at each scrape; high values mean the process cannot keep up |
| `nodejs_eventloop_lag_min_seconds`, `_max_`, `_mean_`, `_stddev_`, `_p50_`, `_p90_`, `_p99_` | gauge | The same delay as measured since the last scrape, as `nodejs_eventloop_lag_<statistic>_seconds` |
| `nodejs_eventloop_utilization_summary`, `nodejs_eventloop_utilization_histogram` | summary, histogram | Share of the time that the event loop is busy |
| `nodejs_heap_size_total_bytes`, `nodejs_heap_size_used_bytes` | gauge | Heap of V8 that is reserved, and used |
| `nodejs_heap_space_size_total_bytes`, `_used_bytes`, `_available_bytes` | gauge | The same by space of the heap, with the label `space` |
| `nodejs_external_memory_bytes` | gauge | Memory of C++ objects bound to JavaScript ones, buffers among them |
| `nodejs_active_handles`, `nodejs_active_requests`, `nodejs_active_resources` | gauge | What keeps the event loop busy, by kind, and the same in `_total` variants as a single number |
| `nodejs_gc_duration_seconds` | histogram | Duration of the garbage collections, by `kind`. It has no samples until the first one happens |
| `nodejs_version_info` | gauge | Version of Node.js, in its labels |
