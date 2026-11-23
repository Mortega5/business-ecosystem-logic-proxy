/** The answer depends on who asks, so no cache keeps it. */
export const PRIVATE = { 'cache-control': 'private, no-store' } as const;

/** The body of a request that the route built itself: it is JSON whatever type the client said. */
export const AS_JSON = { contentType: 'application/json' } as const;
