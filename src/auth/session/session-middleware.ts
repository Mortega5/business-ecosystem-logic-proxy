import type { RequestHandler } from 'express';
import session from 'express-session';
import type { AppConfigService } from '../../config/app-config.service';
import type { AuthStore } from '../store/auth-store';
import { AuthSessionStore } from './session-store';

/**
 * The middleware of the session, with its data in the authentication store. It refuses to be built without a secret: the
 * cookie is signed with it, and a known one lets anybody forge a session.
 */
export const createSessionMiddleware = (config: AppConfigService, store: AuthStore): RequestHandler => {
    const { secret, maxAgeMs, cookieSecure, cookieSameSite } = config.auth.session;
    if (secret === undefined) {
        throw new Error('auth.session.secret is required (at least 32 characters)');
    }
    return session({
        secret,
        store: new AuthSessionStore(store, maxAgeMs),
        // Only a session that has something in it is saved and given a cookie
        resave: false,
        saveUninitialized: false,
        rolling: true,
        cookie: {
            httpOnly: true,
            sameSite: cookieSameSite,
            secure: cookieSecure === 'auto' ? 'auto' : cookieSecure === 'true',
            maxAge: maxAgeMs
        }
    });
};
