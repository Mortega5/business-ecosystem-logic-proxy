import { Store, type SessionData } from 'express-session';
import type { AuthStore } from '../store/auth-store';

const PREFIX = 'session:';

/**
 * The sessions of `express-session`, kept in the same store as the rest of the authentication so that every instance sees
 * them. A session holds only what the login put there: a reference to the token and the OAuth2 states still pending, never
 * the profile.
 */
export class AuthSessionStore extends Store {
    constructor(
        private readonly store: AuthStore,
        private readonly defaultTtlMs: number,
        private readonly now: () => number = Date.now
    ) {
        super();
    }

    get(sid: string, callback: (err: unknown, session?: SessionData | null) => void): void {
        this.store.get(PREFIX + sid).then(
            (value) => callback(null, (value as SessionData | undefined) ?? null),
            (err: unknown) => callback(err)
        );
    }

    set(sid: string, session: SessionData, callback?: (err?: unknown) => void): void {
        this.store.set(PREFIX + sid, session, this.ttlOf(session)).then(
            () => callback?.(),
            (err: unknown) => callback?.(err)
        );
    }

    destroy(sid: string, callback?: (err?: unknown) => void): void {
        this.store.delete(PREFIX + sid).then(
            () => callback?.(),
            (err: unknown) => callback?.(err)
        );
    }

    /** A session that is read stays as long as the cookie says, so a user in use is not logged out. */
    touch(sid: string, session: SessionData, callback?: (err?: unknown) => void): void {
        this.set(sid, session, callback);
    }

    private ttlOf(session: SessionData): number {
        const expires = session.cookie?.expires;
        if (expires === undefined || expires === null) {
            return this.defaultTtlMs;
        }
        const left = new Date(expires).getTime() - this.now();
        return left > 0 ? left : 1;
    }
}
