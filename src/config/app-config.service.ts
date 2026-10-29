import { Inject, Injectable } from '@nestjs/common';
import type { AppConfig } from './config.schema';

export const APP_CONFIG = Symbol('APP_CONFIG');

@Injectable()
export class AppConfigService {
    constructor(@Inject(APP_CONFIG) private readonly value: AppConfig) {}

    get app(): AppConfig['app'] {
        return this.value.app;
    }

    get http(): AppConfig['http'] {
        return this.value.http;
    }

    get logging(): AppConfig['logging'] {
        return this.value.logging;
    }

    get mongo(): AppConfig['mongo'] {
        return this.value.mongo;
    }
}
