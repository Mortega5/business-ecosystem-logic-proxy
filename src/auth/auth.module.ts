import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { LegacyAuthBridge } from '../legacy/legacy-auth.bridge';
import { AuthGuard } from './auth.guard';

@Global()
@Module({
    providers: [LegacyAuthBridge, { provide: APP_GUARD, useClass: AuthGuard }],
    exports: [LegacyAuthBridge]
})
export class AuthModule {}
