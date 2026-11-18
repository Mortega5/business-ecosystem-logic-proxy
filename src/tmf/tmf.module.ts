import { Module } from '@nestjs/common';
import { HttpClientModule } from '../http-client/http-client.module';
import { TmfProxy } from './tmf-proxy';

@Module({
    imports: [HttpClientModule],
    providers: [TmfProxy],
    exports: [TmfProxy]
})
export class TmfModule {}
