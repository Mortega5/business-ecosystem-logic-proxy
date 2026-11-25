# Architecture

The proxy is a NestJS application on Express 5. It serves the APIs of the portal, authenticates the callers, and serves
the compiled portal (`portal/bae-frontend`).

This page explains how a request moves through the application and why the structure is built to refuse by default. To
add an API, see [How to add a TMF API](how-to/add-a-tmf-api.md).

## Life of a request

```
client
  └─ Nest server (Express 5)
       1. security headers, CSRF check, CORS             src/security/configure-security.ts
       2. request logging                                 src/logging/
       3. the router: does a Nest controller own the path?
            yes ─ AuthGuard      who is calling; 401 unless @Public()       src/auth/
                  FeatureGuard   404 when the route's feature is off        src/features/
                  pipes          the ids in the path are checked            src/tmf/resource-id.pipe.ts
                  controller     the rules of that API, in plain code       src/tmf/<api>/
                  TmfProxy       headers, send, answer                      src/tmf/tmf-proxy.ts
                  UpstreamClient a safe path, a timeout, a log line         src/http-client/
            no  ─ PortalFallbackFilter  a browser that asks for a page gets the portal; anything else, a 404   src/portal/portal-static.ts
```

An error thrown anywhere on the way ends in `ErrorFilter` ([`src/common/error.filter.ts`](../src/common/error.filter.ts)).
A `DomainError` carries its status and message, and the answer is `{ "error": message }`, the shape the portal expects.
Any other error becomes a 500 with a generic message, and the stack goes to the log.

## Rules the structure enforces

### Private by default

`AuthGuard` is global. A route is open only with `@Public()`, which does not even open a session. A request with no
token and no session gets a 401.

### Only what the portal uses

A TMF API is a controller with its routes written out. A last route closes the whole prefix with a 404, so a path that
is not listed is not proxied. Without that route, a client of the API would get the page of the portal instead of a
JSON 404.

### Nothing the client says becomes identity

The headers sent upstream are a short list taken from the client's request plus what the authenticated user is known to
be ([`src/tmf/upstream-headers.ts`](../src/tmf/upstream-headers.ts)).

### A path cannot leave its API

The upstream client refuses dot segments (however encoded), separators, `;` and control characters, and it checks the
final URL ([`src/http-client/safe-path.ts`](../src/http-client/safe-path.ts)).

### No default hosts or secrets

An upstream with no host is an error that says what to set. See [Configuration](kubernetes.md#configuration).

## Request bodies

`BodyTextInterceptor` reads a body as text up to `http.bodyLimit` and answers 413 beyond it. It is an interceptor and not
a middleware so that it runs after the guards. A request refused for who it comes from, or for a feature that is off,
keeps its body unread. For the same reason, a check that needs no body, such as `AdministratorGuard`, belongs in a guard.

The proxy never sends a body the controller did not name. A controller that only passes the text through forwards it as
it came. A controller that reads or changes a field to decide something forwards `JSON.stringify` of what it validated,
never the original text. The proxy and the upstream could read the same text differently (duplicate keys, for
instance), and the check would be bypassed.

A file upload (multipart) is not read at all. The middleware leaves that body alone and it reaches the upstream as a
stream, counted against `http.uploadLimit`: 413 beyond it, 415 when the body is not multipart.

## Who may call a route

Private is the default, and each rule narrows or opens it:

- `@Public()` opens a route.
- `@RequireFeature('quotes')` ties a route to a feature. On a controller it covers every route, and the one on a route
  wins.
- `OwnPartyGuard` serves routes that name a party in their path as `:userId`. It lets in only that party (the
  individual, or the organisation when the individual acts for one) and administrators.
- `OwnedResources` serves resources that belong to the parties related to them, such as the inventories. Its `list`
  keeps the client's filters but drops the ones about the related party, then ends the query with the party of the
  caller and its role. Its `read` gives a resource only to a party related to it as a customer. See
  [`src/tmf/inventory/`](../src/tmf/inventory/).

## Shared infrastructure

| Folder | What it holds |
|---|---|
| `src/config` | Zod schema, layered loader, upstream resolution, translation of the `BAE_LP_*` variables of earlier versions |
| `src/http-client` | `UpstreamClient` over `fetch` |
| `src/tmf` | `TmfProxy`, upstream headers, one folder per API |
| `src/auth`, `src/features`, `src/security` | guards and the security configuration |
| `src/persistence` | Mongoose, the base `Repository` and its in-memory fake |
| `src/portal` | `GET /config`, the settings an administrator changes, and the static files of the portal |
| `src/testing` | what the tests share: `FakeUpstream`, `fakeLogin` |
| `docs/openapi.yaml` | the routes Nest serves, checked against the code and the real answers |
