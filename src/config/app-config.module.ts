import { join } from 'node:path';
import { Global, Module } from '@nestjs/common';
import { AppConfigService, APP_CONFIG } from './app-config.service';
import { loadStaticConfig } from './config.loader';

@Global()
@Module({
    providers: [
        {
            provide: APP_CONFIG,
            useFactory: () =>
                loadStaticConfig({
                    defaultsPath: join(process.cwd(), 'config', 'default.yaml'),
                    applicationPath: process.env.CONFIG_FILE,
                    env: process.env
                })
        },
        AppConfigService
    ],
    exports: [AppConfigService]
})
export class AppConfigModule {}
