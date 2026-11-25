import { Module, type MiddlewareConsumer, type NestModule, type OnModuleInit } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service';
import { PartyRegistry } from '../profile/party-registry';
import { createIdentityProvider } from '../providers/identity-provider-factory';
import { IdentityProviderRegistry } from '../providers/identity-provider-registry';
import { createSessionMiddleware } from '../session/session-middleware';
import { AuthStore } from '../store/auth-store';
import { LoginController } from './login.controller';
import { LoginService } from './login.service';

/**
 * The login of the browser: the main identity provider, the session that keeps who has logged in, and the routes that send the user to
 * the provider and take them back. It refuses to start without the settings of the provider or the secret of the session.
 */
@Module({ controllers: [LoginController], providers: [LoginService] })
export class LoginModule implements NestModule, OnModuleInit {
    constructor(
        private readonly config: AppConfigService,
        private readonly store: AuthStore,
        private readonly registry: IdentityProviderRegistry,
        private readonly parties: PartyRegistry
    ) {}

    onModuleInit(): void {
        const { idp, roles, idpTimeoutMs } = this.config.auth;
        const provider = createIdentityProvider(idp, {
            timeoutMs: idpTimeoutMs,
            roles,
            organizationName: (group) => this.parties.organizationName(group)
        });
        // Every provider needs it (the factory has asked for it): the address the provider sends the user back to
        this.registry.add(provider, idp.callbackUrl as string);
    }

    configure(consumer: MiddlewareConsumer): void {
        // Only a session that has something in it is saved or given a cookie, so a request that does not log in leaves none
        consumer.apply(createSessionMiddleware(this.config, this.store)).forRoutes('{*path}');
    }
}
