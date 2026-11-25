# Legacy bridge

Everything that lets the Nest application and the legacy Express 4 application (`server.js`) live in one process.
The folder is deleted at cutover. What refers to it from outside is `bootstrap.ts` (the fallback filter); see `docs/ARCHITECTURE.md` for what changes then.

- `legacy-fallback.filter.ts`: a request Nest has no route for is handed to the legacy app.

Who may call a Nest route is decided by `AuthGuard` (`src/auth`), not here: private by default, `@Public()` to open.
