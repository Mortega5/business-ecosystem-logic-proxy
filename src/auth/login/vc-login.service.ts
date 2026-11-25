import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PinoLogger } from 'nestjs-pino';
import { DomainError, NotFoundError, UnauthorizedError } from '../../common/domain-error';
import { AppConfigService } from '../../config/app-config.service';
import { ProfileService } from '../profile/profile.service';
import type { UserProfile } from '../profile/user-profile';
import { IdentityProviderRegistry, LOCAL_IDP } from '../providers/identity-provider-registry';
import { certificationSubject } from '../providers/vc-certificate';
import { VcProvider } from '../providers/vc-provider';
import { AuthStore } from '../store/auth-store';

/** What the portal makes the state of a login, or of the upload of a certificate (`cert:` and something): nothing that needs escaping. */
const STATE = /^[A-Za-z0-9._~:-]{8,200}$/;
const CERTIFICATE_PREFIX = 'cert:';
// What the verifier answers with is kept for the browser that asked, for a few minutes
const PENDING_TTL_MS = 5 * 60 * 1000;
const CERTIFICATE_TTL_MS = 100 * 1000;

interface Pending {
    /** The code the verifier gave, when it has. */
    code?: string;
    /** The browser that is waiting for it, as the hash of its session. */
    owner?: string;
}

const pendingKey = (state: string): string => `vc:code:${state}`;
const certificateKey = (state: string): string => `vc:cert:${state}`;
const hashOf = (value: string): string => createHash('sha256').update(value).digest('hex');
const isPending = (value: unknown): value is Pending => typeof value === 'object' && value !== null;

/**
 * The login with a wallet. The user shows a credential to the verifier, which either sends the user's browser back to the proxy with a
 * code (redirection) or, when the wallet is on another device, tells the proxy the code and leaves the browser to ask for it (polling).
 */
@Injectable()
export class VcLoginService {
    constructor(
        private readonly providers: IdentityProviderRegistry,
        private readonly profiles: ProfileService,
        private readonly store: AuthStore,
        private readonly config: AppConfigService,
        private readonly logger: PinoLogger
    ) {
        this.logger.setContext(VcLoginService.name);
    }

    /** Whether the user comes back to the proxy with the code, or the verifier tells it and the browser polls. */
    get redirects(): boolean {
        return this.config.auth.vc.isRedirection;
    }

    /** The signed request that the wallet asks for, in the mode where the user comes back to the proxy. */
    requestObject(): string {
        if (!this.config.auth.vc.isRedirection) {
            throw new NotFoundError('Not found');
        }
        return this.provider().requestObject();
    }

    /** The user comes back to the proxy with the code. */
    async finishRedirection(state: unknown, code: unknown): Promise<UserProfile> {
        if (!this.config.auth.vc.isRedirection) {
            throw new NotFoundError('Not found');
        }
        if (!this.valid(state) || typeof code !== 'string' || code === '') {
            throw new UnauthorizedError('Authentication failed');
        }
        return this.admit(code, true);
    }

    /** The verifier says that the user showed a credential: the code is kept for the browser that waits for it, or the credential of a certificate is read at once. */
    async receive(state: unknown, code: unknown): Promise<void> {
        if (this.config.auth.vc.isRedirection) {
            throw new NotFoundError('Not found');
        }
        if (!this.valid(state) || typeof code !== 'string' || code === '') {
            throw new DomainError('Missing required param: state and code', 400);
        }
        if (state.startsWith(CERTIFICATE_PREFIX)) {
            await this.keepCertificate(state, code);
            return;
        }
        const kept = await this.store.get(pendingKey(state));
        const pending: Pending = isPending(kept) ? kept : {};
        await this.store.set(pendingKey(state), { ...pending, code }, PENDING_TTL_MS);
    }

    /**
     * The browser asks whether the user has shown the credential. The first browser to ask about a state is the one that waits for it: the
     * code is given to no other, so that whoever learns the state cannot take the login of whoever showed the credential.
     */
    async poll(state: unknown, browser: string): Promise<UserProfile> {
        if (this.config.auth.vc.isRedirection) {
            throw new NotFoundError('Not found');
        }
        if (!this.valid(state)) {
            throw new UnauthorizedError('Authentication failed');
        }
        const key = pendingKey(state);
        const kept = await this.store.get(key);
        const pending: Pending = isPending(kept) ? kept : {};
        if (this.config.auth.vc.bindPollToSession) {
            const owner = hashOf(browser);
            if (pending.owner === undefined) {
                await this.store.set(key, { ...pending, owner }, PENDING_TTL_MS);
                pending.owner = owner;
            }
            if (pending.owner !== owner) {
                // The same answer as when there is nothing yet: the one who asks does not learn that the state is in use
                throw new UnauthorizedError('No auth code received yet');
            }
        }
        if (pending.code === undefined) {
            throw new UnauthorizedError('No auth code received yet');
        }
        // A code is good for one try, whatever comes of it
        await this.store.delete(key);
        return this.admit(pending.code, false);
    }

    /** The credential of a certification that the user showed: what the portal needs to upload the certificate. */
    async pollCertificate(state: unknown): Promise<{ vc: string, subject: Record<string, unknown> }> {
        if (this.config.auth.vc.isRedirection) {
            throw new NotFoundError('Not found');
        }
        if (!this.valid(state)) {
            throw new DomainError('Missing required param: state', 400);
        }
        const kept = await this.store.get(certificateKey(state));
        if (typeof kept !== 'string' || kept === '') {
            throw new UnauthorizedError('VC not found');
        }
        await this.store.delete(certificateKey(state));
        let payload: Record<string, unknown>;
        try {
            payload = await this.provider().verify(kept);
        } catch {
            this.logger.warn('A VC credential could not be verified');
            throw new DomainError('Invalid VC', 400);
        }
        return { vc: kept, subject: certificationSubject(payload, this.config.auth.vc.certIssuers) };
    }

    private valid(state: unknown): state is string {
        return typeof state === 'string' && STATE.test(state);
    }

    private provider(): VcProvider {
        const provider = this.providers.get(LOCAL_IDP);
        if (!(provider instanceof VcProvider)) {
            throw new NotFoundError('Not found');
        }
        return provider;
    }

    private async keepCertificate(state: string, code: string): Promise<void> {
        let token: string;
        try {
            token = (await this.provider().exchange(code, false)).accessToken;
        } catch {
            this.logger.warn('The token of a VC credential could not be retrieved');
            throw new DomainError('Error loading VC', 500);
        }
        await this.store.set(certificateKey(state), token, CERTIFICATE_TTL_MS);
    }

    private async admit(code: string, authenticated: boolean): Promise<UserProfile> {
        try {
            const { tokens, claims } = await this.provider().login(code, authenticated);
            return await this.profiles.admit(claims, tokens, LOCAL_IDP);
        } catch (error) {
            if (error instanceof UnauthorizedError) {
                throw error;
            }
            this.logger.warn(
                { failure: error instanceof Error ? error.name : 'unknown' },
                'A login with a credential could not be completed'
            );
            // The portal stops asking on a 400 or a 500, and keeps asking on a 401: whatever fails here is a 500, third parties included
            throw new DomainError('The login could not be completed', 500);
        }
    }
}
