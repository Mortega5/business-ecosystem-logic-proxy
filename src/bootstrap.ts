import type { HttpsOptions } from '@nestjs/common/interfaces/external/https-options.interface';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { LegacyFallbackFilter, type LegacyHandler } from './legacy/legacy-fallback.filter';

// bodyParser is off so requests reach the legacy app with their body untouched (it reads raw text)
export const createApp = async (
    legacy: LegacyHandler,
    rootModule: new () => object = AppModule,
    httpsOptions?: HttpsOptions
): Promise<NestExpressApplication> => {
    const app = await NestFactory.create<NestExpressApplication>(rootModule, {
        bufferLogs: true,
        bodyParser: false,
        ...(httpsOptions === undefined ? {} : { httpsOptions })
    });
    app.set('query parser', 'extended');
    app.useLogger(app.get(Logger));
    app.useGlobalFilters(new LegacyFallbackFilter(legacy));
    return app;
};
