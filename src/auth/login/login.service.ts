import { Injectable } from '@nestjs/common';
import type { SessionData } from 'express-session';
import { PinoLogger } from 'nestjs-pino';
import { NotFoundError, UnauthorizedError } from '../../common/domain-error';
import { AppConfigService } from '../../config/app-config.service';
import type { IdentityProvider, LoginCapable } from '../providers/identity-provider';
import { IdentityProviderRegistry, LOCAL_IDP } from '../providers/identity-provider-registry';
import { ProfileService } from '../profile/profile.service';
import type { UserProfile } from '../profile/user-profile';

/** What the session keeps of a login that has been started and not finished. */
export interface PendingLogin {
    idp: string;
    checks: { state: string, nonce: string, codeVerifier: string };
    /** Where the user goes after the login: a path of this site. */
    cameFrom: string;
    startedAt: number;
}

declare module 'express-session' {
    interface SessionData {
        /** The logins started, by their `state`; each can be finished once. */
        logins?: Record<string, PendingLogin>;
        /** The access token of the user who has logged in: the profile is in the authentication store. */
        accessToken?: string;
    }
}

const PENDING_TTL_MS = 10 * 60 * 1000;
const PENDING_MAX = 10;

const canLogin = (provider: IdentityProvider): provider is IdentityProvider & LoginCapable =>
    typeof (provider as Partial<LoginCapable>).beginLogin === 'function' &&
    typeof (provider as Partial<LoginCapable>).finishLogin === 'function';

/** A path of this site and nothing else, so that a login cannot send the user to another one. */
export const sitePath = (value: unknown): string =>
    typeof value === 'string' && /^\/(?![/\\])[^\u0000-\u001f\\]*$/.test(value) ? value : '/';

export interface LoginDone {
    profile: UserProfile;
    /** Where to send the browser. */
    redirectTo: string;
}

/** The two steps of a login with an identity provider: send the user to it, and take them in when it sends them back. */
@Injectable()
export class LoginService {
    constructor(
        private readonly providers: IdentityProviderRegistry,
        private readonly profiles: ProfileService,
        private readonly config: AppConfigService,
        private readonly logger: PinoLogger
    ) {
        this.logger.setContext(LoginService.name);
    }

    /** The address of the identity provider to send the browser to. The session keeps what the answer will be checked against. */
    async begin(session: SessionData, idp: string, cameFrom: string): Promise<string> {
        const { provider, callbackUrl } = this.resolve(idp);
        const { url, checks } = await provider.beginLogin(callbackUrl);

        const logins = this.live(session);
        logins[checks.state] = { idp, checks, cameFrom: sitePath(cameFrom), startedAt: Date.now() };
        // A browser that starts logins and never finishes them does not make the session grow
        for (const state of Object.keys(logins).slice(0, -PENDING_MAX)) {
            delete logins[state];
        }
        session.logins = logins;
        return url;
    }

    /** Finishes the login for what the identity provider sent back (the query of the callback). */
    async complete(session: SessionData, idp: string, query: Record<string, unknown>): Promise<LoginDone> {
        const { provider, callbackUrl } = this.resolve(idp);
        const state = typeof query['state'] === 'string' ? query['state'] : '';
        const logins = this.live(session);
        const pending = logins[state];
        // Used up whatever happens next: an answer is good for one try
        delete logins[state];
        session.logins = logins;
        if (pending === undefined || pending.idp !== idp) {
            throw new UnauthorizedError('The login is not valid or has expired');
        }

        const params = new URLSearchParams();
        for (const [name, value] of Object.entries(query)) {
            if (typeof value === 'string') {
                params.set(name, value);
            }
        }
        try {
            const { tokens, claims } = await provider.finishLogin(
                `${callbackUrl}?${params.toString()}`,
                pending.checks
            );
            const profile = await this.profiles.admit(claims, tokens, idp);
            session.accessToken = profile.accessToken;
            return { profile, redirectTo: this.redirectFor(idp, profile, pending) };
        } catch (error) {
            this.logger.warn(
                { idp, failure: error instanceof Error ? error.name : 'unknown' },
                'A login could not be completed'
            );
            throw error instanceof UnauthorizedError
                ? error
                : new UnauthorizedError('The login could not be completed');
        }
    }

    private resolve(idp: string): { provider: IdentityProvider & LoginCapable, callbackUrl: string } {
        const provider = this.providers.get(idp);
        const callbackUrl = this.providers.callbackUrlOf(idp);
        if (provider === undefined || !canLogin(provider) || callbackUrl === undefined) {
            throw new NotFoundError('There is no such identity provider');
        }
        return { provider, callbackUrl };
    }

    private live(session: SessionData): Record<string, PendingLogin> {
        const limit = Date.now() - PENDING_TTL_MS;
        return Object.fromEntries(
            Object.entries(session.logins ?? {}).filter(([, pending]) => pending.startedAt > limit)
        );
    }

    private redirectFor(idp: string, profile: UserProfile, pending: PendingLogin): string {
        if (idp !== LOCAL_IDP) {
            return pending.cameFrom;
        }
        const { externalPortal } = this.config.auth;
        // The portal of another site cannot read the session of this one, so it is given the token, as v11 did
        return externalPortal === undefined
            ? '/dashboard?token=local'
            : `${externalPortal.replace(/\/+$/, '')}/dashboard?token=${encodeURIComponent(profile.accessToken)}`;
    }
}
