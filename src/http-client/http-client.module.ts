import { Module } from '@nestjs/common';
import { FetchUpstreamClient } from './fetch-upstream-client';
import { UpstreamClient } from './upstream-client';

@Module({
    providers: [{ provide: UpstreamClient, useClass: FetchUpstreamClient }],
    exports: [UpstreamClient]
})
export class HttpClientModule {}
