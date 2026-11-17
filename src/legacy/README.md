# Legacy bridge

Everything that lets the Nest application and the legacy Express 4 application (`server.js`) live in one process.
Nothing outside this folder should know the legacy app exists, and the whole folder is deleted at cutover.

- `legacy-fallback.filter.ts`: a request Nest has no route for is handed to the legacy app.
- `legacy-auth.bridge.ts`: runs the legacy session, passport and authentication middlewares on a request that a Nest
  route serves, so it has `req.user`. `server.js` exposes them as `authPipeline`; `start.ts` attaches them.

Who may call a Nest route is decided by `AuthGuard` (`src/auth`), not here: private by default, `@Public()` to open.
When authentication is migrated, the bridge goes and the guard resolves the user itself.
