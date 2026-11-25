import { Injectable, type OnModuleInit } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { PinoLogger } from 'nestjs-pino';
import { DomainError, NotFoundError } from '../../common/domain-error';
import { AppConfigService } from '../../config/app-config.service';
import { I4TrustProvider } from '../providers/i4trust-provider';
import { IdentityProviderRegistry, LOCAL_IDP } from '../providers/identity-provider-registry';
import type { IdpChangeForm, IdpView, NewIdpForm } from './idp-form';
import { IdpRepository } from './idp.repository';
import type { Idp } from './idp.schema';

const isDuplicate = (error: unknown): boolean =>
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11000;

const viewOf = (idp: Idp): IdpView => ({
    name: idp.name,
    server: idp.server,
    idpId: idp.idpId,
    ...(idp.issuerDid === undefined || idp.issuerDid === null ? {} : { issuerDid: idp.issuerDid }),
    ...(idp.description === undefined || idp.description === null ? {} : { description: idp.description })
});

/**
 * The identity providers that an administrator adds at run time. Each is an i4Trust one, with the proxy as a client under its own
 * EORI. They are kept in MongoDB, and the ones that are there are available for login from the start.
 */
@Injectable()
export class IdpService implements OnModuleInit {
    private keys: { keyPem: string, certificatePem: string } | undefined;

    constructor(
        private readonly idps: IdpRepository,
        private readonly registry: IdentityProviderRegistry,
        private readonly config: AppConfigService,
        private readonly logger: PinoLogger
    ) {
        this.logger.setContext(IdpService.name);
    }

    async onModuleInit(): Promise<void> {
        if (!this.config.auth.externalLogin.enabled) {
            return;
        }
        for (const idp of await this.idps.find()) {
            // One that cannot be loaded does not stop the others, or the start
            try {
                this.register(idp);
            } catch (error) {
                this.logger.error(
                    { idpId: idp.idpId, failure: error instanceof Error ? error.message : 'unknown' },
                    'An identity provider could not be loaded'
                );
            }
        }
    }

    async list(search?: string): Promise<IdpView[]> {
        this.settings();
        const found = await (search === undefined ? this.idps.find() : this.idps.search(search));
        return found.map(viewOf);
    }

    async get(idpId: string): Promise<IdpView> {
        this.settings();
        return viewOf(await this.existing(idpId));
    }

    async create(form: NewIdpForm): Promise<void> {
        this.assertFree(form.idpId);
        const { eori, tokenKey, tokenCrt } = this.settings();
        const record: Idp = {
            provider: 'i4trust',
            name: form.name,
            server: form.server,
            idpId: form.idpId,
            clientID: eori,
            callbackURL: `${this.publicOrigin()}/auth/${encodeURIComponent(form.idpId)}/callback`,
            tokenKey,
            tokenCrt,
            ...(form.issuerDid === undefined ? {} : { issuerDid: form.issuerDid }),
            ...(form.description === undefined ? {} : { description: form.description })
        };
        // Built first: one that cannot be built is not kept
        this.build(record);
        try {
            await this.idps.create(record);
        } catch (error) {
            if (isDuplicate(error)) {
                throw new DomainError('The provided IDP ID is already registered', 409);
            }
            throw error;
        }
        this.register(record);
        this.logger.info({ idpId: form.idpId }, 'An identity provider was added');
    }

    async update(idpId: string, form: IdpChangeForm): Promise<void> {
        this.settings();
        const current = await this.existing(idpId);
        const changed: Idp = { ...current, name: form.name, server: form.server };
        delete changed.issuerDid;
        delete changed.description;
        if (form.issuerDid !== undefined) {
            changed.issuerDid = form.issuerDid;
        }
        if (form.description !== undefined) {
            changed.description = form.description;
        }
        this.build(changed);
        await this.idps.replace(idpId, changed);
        this.register(changed);
        this.logger.info({ idpId }, 'An identity provider was changed');
    }

    async remove(idpId: string): Promise<void> {
        this.settings();
        await this.idps.deleteMany({ idpId });
        this.registry.remove(idpId);
        this.logger.info({ idpId }, 'An identity provider was removed');
    }

    private async existing(idpId: string): Promise<Idp> {
        const found = await this.idps.findOne({ idpId });
        if (found === undefined) {
            throw new NotFoundError('Idp not found');
        }
        return found;
    }

    /** An id that is the main provider or is taken by it would make two logins share one address. */
    private assertFree(idpId: string): void {
        if (idpId === LOCAL_IDP || idpId === this.config.auth.idp.provider) {
            throw new DomainError('The provided IDP ID is reserved', 400);
        }
    }

    private settings(): { eori: string, tokenKey: string, tokenCrt: string } {
        const { enabled, eori, tokenKey, tokenCrt } = this.config.auth.externalLogin;
        if (!enabled || eori === undefined || tokenKey === undefined || tokenCrt === undefined) {
            throw new NotFoundError('Not found');
        }
        return { eori, tokenKey, tokenCrt };
    }

    /** The site of the proxy, which is where the main provider sends its users back to. */
    private publicOrigin(): string {
        const callback = this.config.auth.idp.callbackUrl;
        if (callback === undefined) {
            throw new Error('auth.idp.callbackUrl is needed to know the address of the proxy');
        }
        return new URL(callback).origin;
    }

    private build(record: Idp): I4TrustProvider {
        const { eori } = this.settings();
        this.keys ??= {
            keyPem: readFileSync(this.settings().tokenKey, 'utf8'),
            certificatePem: readFileSync(this.settings().tokenCrt, 'utf8')
        };
        return new I4TrustProvider({
            id: record.idpId,
            roles: this.config.auth.roles,
            login: {
                server: record.server,
                clientId: eori,
                idpId: record.idpId,
                scope: 'jwt openid iSHARE email profile',
                ...this.keys,
                timeoutMs: this.config.auth.idpTimeoutMs
            }
        });
    }

    private register(record: Idp): void {
        if (record.provider !== 'i4trust') {
            throw new Error(`The provider ${record.provider} is not supported for external login`);
        }
        this.registry.add(this.build(record), record.callbackURL);
    }
}
