import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage<string>();

/** Makes the id of the request the one that `currentRequestId` gives for all that runs from here on. */
export const enterRequest = (id: string): void => storage.enterWith(id);

/** The id of the request that is being served, to pass it on to what the proxy calls for it. */
export const currentRequestId = (): string | undefined => storage.getStore();
