# DOME extension

What the DOME marketplace adds to the core: the blog, the analytics, the compliance certificates and the verifiable credentials.

Rules, so that it can be taken out:

- Nothing outside `src/dome` imports from it, except the one line that imports `DomeModule` in `src/app.module.ts`.
- It may import from the core (`auth`, `config`, `http-client`, `tmf`, `persistence`...), through what the core modules export.
- Its settings are under `dome.*` in the configuration, and `dome.enabled` turns the whole extension off: its routes answer 404.
- Every controller is marked `@DomeRoutes()`. Anything that starts on its own (a timer, a connection) checks `dome.enabled` first.
