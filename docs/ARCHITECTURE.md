# Architecture

The proxy is being moved from an Express 4 application (`server.js`) to NestJS, one API at a time. Until the move is
over both live in one process: Nest is the outer application and hands every request it has no route for to the legacy
one. Everything that makes that possible is in [`src/legacy/`](../src/legacy/README.md) and is deleted at the end.

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
            no  ─ LegacyFallbackFilter hands it to server.js, which authenticates and routes it its own way
```

An error thrown anywhere on the way ends in `ErrorFilter` ([`src/common/error.filter.ts`](../src/common/error.filter.ts)):
`DomainError` carries its status and message and the answer is `{ "error": message }`, the shape the portal expects;
anything unexpected is a 500 with a generic message and the stack goes to the log.

## Rules the structure enforces

- **Private by default.** `AuthGuard` is global. A route is open only with `@Public()`, which does not even open a
  session. Without the legacy authentication chain attached, every private route answers 401.
- **Only what the portal uses.** A TMF API is a controller with its routes written out. The whole prefix is closed by a
  last route that answers 404, so what is not listed is neither proxied nor handed to the legacy application.
- **Nothing the client says becomes identity.** The headers sent upstream come from a short list of the client's plus
  what the authenticated user is known to be ([`src/tmf/upstream-headers.ts`](../src/tmf/upstream-headers.ts)).
- **A path cannot leave its API.** The upstream client refuses dot segments (however encoded), separators, `;` and
  control characters, and checks the final URL ([`src/http-client/safe-path.ts`](../src/http-client/safe-path.ts)).
- **No default hosts or secrets.** An upstream with no host is an error that says what to set; see
  [Configuration](kubernetes.md#configuration).

## Where things are

| Folder | What it holds |
|---|---|
| `src/config` | Zod schema, layered loader, upstream resolution, translation of the legacy `BAE_LP_*` variables |
| `src/http-client` | `UpstreamClient` over `fetch` |
| `src/tmf` | `TmfProxy`, upstream headers, one folder per API |
| `src/auth`, `src/features`, `src/security` | guards and the security configuration |
| `src/persistence` | Mongoose, the base `Repository` and its in-memory fake |
| `src/legacy` | the bridge to the legacy application; temporary |
| `src/testing` | what the tests share: `FakeUpstream`, `fakeLogin` |
| `docs/openapi.yaml` | the routes Nest serves, checked against the code and the real answers |

## How to add a TMF API

Take [`src/tmf/document/`](../src/tmf/document/) as the model.

1. **Find what the portal calls.** Read the portal's source for that API (URLs are built from `environment` constants
   and runtime configuration, so follow the constants) and list method, path and query. Nothing else is exposed.
2. **Name the upstream.** Its name is in `TMFORUM_APIS` ([`src/config/upstream-names.ts`](../src/config/upstream-names.ts))
   with its standard path in `config/default.yaml`; the server is `upstreams.tmforum.host`/`port`, or its own.
3. **Write the controller.** One method per route, ids through `ResourceIdPipe`, then `this.proxy.forward(req, res,
   { upstream, path })`. A route can also fix the query it sends (`search`) and set
   headers of the answer (`responseHeaders`, for instance a sandbox policy for HTML that is not ours). If the API validates or changes something, call `send`, do it, then `reply`. End with the
   route that closes the prefix:

   ```ts
   @All(['', '{*path}'])
   closed(): never {
       throw new NotFoundError('Not found');
   }
   ```

   `NotFoundError` and not `NotFoundException`: the latter is what hands a request to the legacy application. This
   route exists only while the legacy application does; without it Nest's own 404 is enough, and these routes are removed.
4. **If a route takes a body,** apply `RawTextMiddleware` to the controller in its module (`consumer.apply(RawTextMiddleware)
   .forRoutes(...)`, see `search.module.ts`): it reads the body as text up to `http.bodyLimit` and answers 413 beyond it.
   Check it with a pipe such as `JsonBodyPipe` and hand it to `forward` explicitly (`{ upstream, path, body }`); the proxy
   never sends a body the controller did not name. A route that takes none needs nothing.

   The text is forwarded as it came only when the controller does not look into it. When it reads or changes a field
   to decide something, it forwards `JSON.stringify` of what it validated and never the original text: the proxy and
   the upstream could read the same text differently (duplicate keys, for instance) and the check would be bypassed.
   A route that takes a file upload (multipart) passes `upload: true` to `forward`: the middleware leaves that body
   alone and it goes on to the upstream as a stream, counted against `http.uploadLimit` (413 beyond it, 415 when it is
   not multipart). `OptionalJsonBodyPipe` is the pipe for a route that may come with no body.
5. **Say who may call it.** Nothing means private. `@Public()` opens it, `@RequireFeature('quotes')` ties it to a
   feature, on the controller or on a route; the one of a route wins. A route that names a party in its path as `:userId` uses `OwnPartyGuard`, which lets in only that party (the
   individual's, or the organisation's when acting for one) and administrators.
6. **Register the module** in `AppModule` and **document the routes** in `docs/openapi.yaml`; the test in
   `src/docs/openapi.spec.ts` fails until every route and every documented answer has a case.
7. **Test it.** A controller spec with `FakeUpstream` and `fakeLogin` (see `document.controller.spec.ts`): the happy
   path, 401, a refused id, every route that must be closed. Dot-segment ids must be sent with `http.request`, because
   `fetch` normalises them.

## When the legacy application goes away

The bridge is referenced from a few places outside `src/legacy/`, and those are what changes:

- `src/auth/auth.guard.ts` and `auth.module.ts` stop using `LegacyAuthBridge`; the guard resolves the user itself.
- `src/start.ts` stops attaching `authPipeline` and `src/bootstrap.ts` stops registering the fallback filter.
- The closing `@All` route of each API controller is deleted: Nest's default 404 does the same.
- `server.js` and its `authPipeline` export go, and so does `src/testing/fake-login.ts` (replaced by a fake strategy).
- Then `src/legacy/` is deleted.
