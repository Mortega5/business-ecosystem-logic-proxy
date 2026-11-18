# Legacy bridge

Everything that lets the Nest application and the legacy Express 4 application (`server.js`) live in one process.
The folder is deleted at cutover. What refers to it from outside is `AuthGuard` and `AuthModule` (the bridge), `start.ts` (which attaches the chain) and `bootstrap.ts` (the fallback filter); see `docs/ARCHITECTURE.md` for what changes then.

- `legacy-fallback.filter.ts`: a request Nest has no route for is handed to the legacy app.
- `legacy-auth.bridge.ts`: runs the legacy session, passport and authentication middlewares on a request that a Nest
  route serves, so it has `req.user`. `server.js` exposes them as `authPipeline`; `start.ts` attaches them.

Who may call a Nest route is decided by `AuthGuard` (`src/auth`), not here: private by default, `@Public()` to open.
When authentication is migrated, the bridge goes and the guard resolves the user itself.
