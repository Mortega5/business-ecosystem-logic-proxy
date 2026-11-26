/** The address of what a stubbed fetch was asked for, whichever of the forms of its first argument it came in. */
export const urlOf = (input: RequestInfo | URL): string => (typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);

/** The body of a request that a stubbed fetch got, when it is a text or form parameters. */
export const bodyOf = (init?: RequestInit): string => {
    const body = init?.body;
    return typeof body === 'string' ? body : body instanceof URLSearchParams ? body.toString() : '';
};
