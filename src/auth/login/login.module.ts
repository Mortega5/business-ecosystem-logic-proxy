import { Module, type MiddlewareConsumer, type NestModule, type OnModuleInit } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service';
import { PartyRegistry } from '../profile/party-registry';
import { createMainIdentityProvider } from '../providers/identity-provider-factory';
import { IdentityProviderRegistry } from '../providers/identity-provider-registry';
import { createSessionMiddleware } from '../session/session-middleware';
import { AuthStore } from '../store/auth-store';
import { LoginController } from './login.controller';
import { LoginService } from './login.service';
import { VcEnabledGuard } from './vc-enabled.guard';
import { VcLoginController } from './vc-login.controller';
import { VcLoginService } from './vc-login.service';

/**
 * The login of the browser: the main identity provider, the session that keeps who has logged in, and the routes that send the user to
 * the provider and take them back. It refuses to start without the settings of the provider or the secret of the session.
 */
// The routes of the login with credentials come first: `/auth/vc/callback` would also be taken for the callback of a provider called vc
@Module({ controllers: [VcLoginController, LoginController], providers: [LoginService, VcLoginService, VcEnabledGuard] })
export class LoginModule implements NestModule, OnModuleInit {
    constructor(
        private readonly config: AppConfigService,
        private readonly store: AuthStore,
        private readonly registry: IdentityProviderRegistry,
        private readonly parties: PartyRegistry
    ) {}

    onModuleInit(): void {
        const { auth } = this.config;
        // The login with credentials, when it is on, takes the place of the provider of `auth.idp`
        const { provider, callbackUrl } = createMainIdentityProvider(auth, {
            timeoutMs: auth.idpTimeoutMs,
            roles: auth.roles,
            organizationName: (group) => this.parties.organizationName(group)
        });
        // The address the provider sends the user back to
        this.registry.add(provider, callbackUrl);
    }

    configure(consumer: MiddlewareConsumer): void {
        // Only a session that has something in it is saved or given a cookie, so a request that does not log in leaves none
        consumer.apply(createSessionMiddleware(this.config, this.store)).forRoutes('{*path}');
    }
}
