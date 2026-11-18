import { Module } from '@nestjs/common';
import { HttpClientModule } from '../http-client/http-client.module';
import { OwnedResources } from './owned-resources';
import { TmfProxy } from './tmf-proxy';

@Module({
    imports: [HttpClientModule],
    providers: [TmfProxy, OwnedResources],
    exports: [TmfProxy, OwnedResources]
})
export class TmfModule {}
