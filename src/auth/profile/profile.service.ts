import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { AppConfigService } from '../../config/app-config.service';
import { BadGatewayError, DomainError, UnauthorizedError } from '../../common/domain-error';
import { AuthStore } from '../store/auth-store';
import type { IdentityProvider, IdentityTokens } from '../providers/identity-provider';
import { IdentityProviderRegistry, LOCAL_IDP } from '../providers/identity-provider-registry';
import { PartyRegistry } from './party-registry';
import { SingleFlight } from './single-flight';
import { isUserProfile, type IdentityClaims, type UserProfile } from './user-profile';

const profileKey = (accessToken: string): string => `profile:${accessToken}`;
const nowS = (): number => Math.floor(Date.now() / 1000);

/**
 * Who a token belongs to. A token the proxy has seen is answered from the store, refreshed when it is about to end; one it has not
 * seen is an API client's and is asked to the main identity provider. Either way the party of the user is in TMForum when this ends.
 */
@Injectable()
export class ProfileService {
    private readonly refreshing = new SingleFlight<UserProfile>();
    private readonly loading = new SingleFlight<UserProfile>();

    constructor(
        private readonly store: AuthStore,
        private readonly providers: IdentityProviderRegistry,
        private readonly parties: PartyRegistry,
        private readonly config: AppConfigService,
        private readonly logger: PinoLogger
    ) {
        this.logger.setContext(ProfileService.name);
    }

    /** The profile of the access token; rejects with `UnauthorizedError` when the token is not valid. */
    async authenticate(accessToken: string): Promise<UserProfile> {
        const kept = await this.store.get(profileKey(accessToken));
        if (!isUserProfile(kept)) {
            return this.loading.run(accessToken, () => this.loadUnknown(accessToken));
        }
        return kept.expire - nowS() > this.config.auth.refreshMarginSeconds ? kept : this.refresh(kept);
    }

    /** Completes what a provider said of a user who has just logged in, and keeps it. */
    async admit(claims: IdentityClaims, tokens: IdentityTokens, idp: string): Promise<UserProfile> {
        const partyId = await this.registered(claims, async () => this.parties.individualFor(claims));
        const organizations = await this.registered(claims, () => this.parties.organizationsFor(claims, partyId));
        const profile: UserProfile = {
            ...claims,
            displayName: claims.displayName || claims.username,
            organizations,
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken ?? '',
            expire: tokens.expire ?? claims.expire ?? nowS() + this.config.auth.defaultTokenLifetimeSeconds,
            idp,
            partyId
        };
        const remainingMs = (profile.expire - nowS()) * 1000;
        await this.store.set(profileKey(profile.accessToken), profile, profile.refreshToken === '' ? Math.max(remainingMs, 1) : this.config.auth.profileTtlMs);
        this.logger.debug({ userId: profile.id, idp }, 'A profile was kept');
        return profile;
    }

    /** Forgets the profile of a token, as when the user logs out. */
    forget(accessToken: string): Promise<void> {
        return this.store.delete(profileKey(accessToken));
    }

    private async loadUnknown(accessToken: string): Promise<UserProfile> {
        const local = this.providers.get(LOCAL_IDP);
        if (local === undefined) {
            throw new UnauthorizedError('It has not been possible to obtain your user info');
        }
        const claims = await this.claims(local, accessToken);
        return this.admit(claims, { accessToken }, LOCAL_IDP);
    }

    // A refresh token is used once, so everybody who needs the refresh of the same one waits for the first that asked
    private refresh(profile: UserProfile): Promise<UserProfile> {
        if (profile.refreshToken === '') {
            this.logger.info({ userId: profile.id, idp: profile.idp }, 'A token ended and cannot be refreshed');
            throw new UnauthorizedError('Your access token has expired');
        }
        return this.refreshing.run(profile.refreshToken, async () => {
            const provider = this.providers.get(profile.idp);
            if (provider === undefined) {
                throw new UnauthorizedError('It has not been possible to obtain your user info');
            }
            let tokens: IdentityTokens;
            try {
                tokens = await provider.refresh(profile.refreshToken);
            } catch (err) {
                this.logger.warn({ err, userId: profile.id, idp: profile.idp }, 'A token could not be refreshed');
                throw new UnauthorizedError('It has not been possible to obtain your user info');
            }
            const claims = await this.claims(provider, tokens.accessToken);
            const renewed = await this.admit(claims, tokens, profile.idp);
            const remainingMs = Math.max((renewed.expire - nowS()) * 1000, 1);
            await this.store.set(profileKey(profile.accessToken), renewed, Math.min(this.config.auth.replacedTokenGraceMs, remainingMs));
            return renewed;
        });
    }

    private async claims(provider: IdentityProvider, accessToken: string): Promise<IdentityClaims> {
        try {
            return await provider.claimsOf(accessToken);
        } catch (err) {
            this.logger.info({ err, idp: provider.id }, 'A token was not accepted by its identity provider');
            throw new UnauthorizedError('It has not been possible to obtain your user info');
        }
    }

    // The identity provider vouched for the user: a failure here is TMForum's, not the user's
    private async registered<T>(claims: IdentityClaims, work: () => Promise<T>): Promise<T> {
        try {
            return await work();
        } catch (err) {
            if (err instanceof DomainError) {
                throw err;
            }
            this.logger.warn({ err, userId: claims.id }, 'The parties of a user could not be registered');
            throw new BadGatewayError('The user could not be registered');
        }
    }
}
