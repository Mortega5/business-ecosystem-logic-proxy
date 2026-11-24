/**
 * Where the authentication keeps what it has to remember: the profile of each access token and the state of a login in
 * progress. Whatever is put in has to be plain JSON. A value is gone when its time is over; nothing keeps it longer.
 *
 * Implementations: memory (the default, one process) and Mongo (shared by every instance). The keys are made up by the
 * caller, with a prefix for what they are (`profile:`, `state:`), and an implementation is free to store them hashed.
 */
export abstract class AuthStore {
    /** The value, or undefined when there is none or it has expired. */
    abstract get(key: string): Promise<unknown>;

    abstract set(key: string, value: unknown, ttlMs: number): Promise<void>;

    abstract delete(key: string): Promise<void>;
}
