# DOME extension

What belongs only to the DOME marketplace and not to the core. For now it has no pieces of its own: the blog (`src/blog`, which `/domeblog` also reaches while `dome.enabled` is on), the analytics (`src/analytics`) and the compliance (`src/compliance`) are part of the core, each with its own setting, and the login with verifiable credentials is one more identity provider.

Rules, so that it can be taken out:

- Nothing outside `src/dome` imports from it, except the one line that imports `DomeModule` in `src/app.module.ts`.
- It may import from the core (`auth`, `config`, `http-client`, `tmf`, `persistence`...), through what the core modules export.
- Its settings are under `dome.*` in the configuration, and `dome.enabled` turns the whole extension off: its routes answer 404.
- Every controller is marked `@DomeRoutes()`. Anything that starts on its own (a timer, a connection) checks `dome.enabled` first.
