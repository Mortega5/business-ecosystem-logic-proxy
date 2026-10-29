import { Global, Module } from '@nestjs/common';
import { AppConfigService, APP_CONFIG } from './app-config.service';
import { loadAppConfig } from './config.loader';

@Global()
@Module({
    providers: [{ provide: APP_CONFIG, useFactory: () => loadAppConfig(process.env) }, AppConfigService],
    exports: [AppConfigService]
})
export class AppConfigModule {}
