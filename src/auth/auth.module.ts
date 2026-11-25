import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { getConnectionToken } from '@nestjs/mongoose';
import type { Connection, Model } from 'mongoose';
import { AppConfigService } from '../config/app-config.service';
import { HttpClientModule } from '../http-client/http-client.module';
import { AuthGuard } from './auth.guard';
import { PartyRegistry } from './profile/party-registry';
import { ProfileService } from './profile/profile.service';
import { IdentityProviderRegistry } from './providers/identity-provider-registry';
import { RequestAuthenticator } from './request-authenticator';
import { AuthCacheEntry, AuthCacheEntrySchema } from './store/auth-cache.schema';
import { AuthStore } from './store/auth-store';
import { MemoryAuthStore } from './store/memory-auth-store';
import { MongoAuthStore } from './store/mongo-auth-store';
import { SecretBox } from './store/secret-box';

/** The store the configuration chooses. Another one (Redis, say) is one more class and one more branch here. */
export const createAuthStore = (config: AppConfigService, connection: Connection | undefined): AuthStore => {
    const { type, memoryMaxEntries, encryptionKey } = config.auth.store;
    if (type === 'mongo') {
        if (encryptionKey === undefined) {
            throw new Error('auth.store.encryptionKey is required when auth.store.type is mongo');
        }
        if (connection === undefined) {
            throw new Error('auth.store.type is mongo but there is no MongoDB connection');
        }
        const model = connection.model(AuthCacheEntry.name, AuthCacheEntrySchema) as unknown as Model<AuthCacheEntry>;
        return new MongoAuthStore(model, new SecretBox(encryptionKey));
    }
    return new MemoryAuthStore(memoryMaxEntries);
};

@Global()
@Module({
    imports: [HttpClientModule],
    providers: [
        IdentityProviderRegistry,
        PartyRegistry,
        ProfileService,
        RequestAuthenticator,
        { provide: APP_GUARD, useClass: AuthGuard },
        {
            provide: AuthStore,
            // The connection is only needed with the mongo store, so the module also works where there is no database
            inject: [AppConfigService, { token: getConnectionToken(), optional: true }],
            useFactory: createAuthStore
        }
    ],
    exports: [AuthStore, IdentityProviderRegistry, PartyRegistry, ProfileService, RequestAuthenticator]
})
export class AuthModule {}
