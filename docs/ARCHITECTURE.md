# Architecture

The proxy is a NestJS application (Express 5). It serves the APIs of the portal, authenticates the callers, and serves
the compiled portal (`portal/bae-frontend`).

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

An error thrown anywhere on the way ends in `ErrorFilter` ([`src/common/error.filter.ts`](../src/common/error.filter.ts)):
`DomainError` carries its status and message and the answer is `{ "error": message }`, the shape the portal expects;
anything unexpected is a 500 with a generic message and the stack goes to the log.

## Rules the structure enforces

- **Private by default.** `AuthGuard` is global. A route is open only with `@Public()`, which does not even open a
  session. A request with no token and no session answers 401.
- **Only what the portal uses.** A TMF API is a controller with its routes written out. The whole prefix is closed by a
  last route that answers 404, so what is not listed is not proxied, and a client of the API gets a JSON 404 and not the page of the portal.
- **Nothing the client says becomes identity.** The headers sent upstream come from a short list of the client's plus
  what the authenticated user is known to be ([`src/tmf/upstream-headers.ts`](../src/tmf/upstream-headers.ts)).
- **A path cannot leave its API.** The upstream client refuses dot segments (however encoded), separators, `;` and
  control characters, and checks the final URL ([`src/http-client/safe-path.ts`](../src/http-client/safe-path.ts)).
- **No default hosts or secrets.** An upstream with no host is an error that says what to set; see
  [Configuration](kubernetes.md#configuration).

## Where things are

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

   `NotFoundError` and not `NotFoundException`: the latter is what serves the page of the portal to a browser that asks for
   a path that has no route. This route is what keeps a prefix of an API from answering with the portal.
4. **If a route takes a body,** apply `BodyTextInterceptor` to the controller (`@UseInterceptors(BodyTextInterceptor)`, see
   `search.controller.ts`): it reads the body as text up to `http.bodyLimit` and answers 413 beyond it. It is an interceptor and not a
   middleware so that it runs after the guards: a request that is refused for who it comes from, or for a feature that is off, has
   its body left unread, and so a check that needs no body (such as `AdministratorGuard`) belongs in a guard.
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
   Resources that belong to the parties related to them (the inventories) use `OwnedResources`: `list` sends on the filters of
   the client, drops the ones about the related party and ends the query with the party of the caller and its role, and
   `read` gives a resource only to a party related to it as a customer. See `src/tmf/inventory/`.
6. **Register the module** in `AppModule` and **document the routes** in `docs/openapi.yaml`; the test in
   `src/docs/openapi.spec.ts` fails until every route and every documented answer has a case.
7. **Test it.** A controller spec with `FakeUpstream` and `fakeLogin` (see `document.controller.spec.ts`): the happy
   path, 401, a refused id, every route that must be closed. Dot-segment ids must be sent with `http.request`, because
   `fetch` normalises them.
