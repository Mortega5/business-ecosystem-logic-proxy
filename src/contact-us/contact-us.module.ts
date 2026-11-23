import { Module } from '@nestjs/common';
import { HttpClientModule } from '../http-client/http-client.module';
import { ContactUsController } from './contact-us.controller';

@Module({ imports: [HttpClientModule], controllers: [ContactUsController] })
export class ContactUsModule {}
