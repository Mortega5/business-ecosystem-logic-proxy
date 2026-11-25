import type { HttpsOptions } from '@nestjs/common/interfaces/external/https-options.interface';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { ErrorFilter } from './common/error.filter';
import { PortalFallbackFilter } from './portal/portal-static';

// bodyParser is off: each route reads the body as the text it needs
export const createApp = async (rootModule: new () => object = AppModule, httpsOptions?: HttpsOptions): Promise<NestExpressApplication> => {
    const app = await NestFactory.create<NestExpressApplication>(rootModule, {
        bufferLogs: true,
        bodyParser: false,
        ...(httpsOptions === undefined ? {} : { httpsOptions })
    });
    app.set('query parser', 'extended');
    app.disable('x-powered-by');
    app.useLogger(app.get(Logger));
    app.useGlobalFilters(new ErrorFilter(), new PortalFallbackFilter());
    return app;
};
