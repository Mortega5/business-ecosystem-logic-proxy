import { Test } from '@nestjs/testing';
import { LoggerModule } from 'nestjs-pino';
import { describe, expect, it } from 'vitest';
import { AppConfigModule } from '../config/app-config.module';
import { FetchUpstreamClient } from './fetch-upstream-client';
import { HttpClientModule } from './http-client.module';
import { UpstreamClient } from './upstream-client';

describe('HttpClientModule', () => {
    it('provides the fetch based client as the UpstreamClient', async () => {
        const module = await Test.createTestingModule({
            imports: [AppConfigModule, LoggerModule.forRoot({ pinoHttp: { level: 'silent' } }), HttpClientModule]
        }).compile();

        expect(module.get(UpstreamClient)).toBeInstanceOf(FetchUpstreamClient);
    });
});
