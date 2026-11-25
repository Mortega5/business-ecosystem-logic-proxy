import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { IdpController } from './idp.controller';
import { IdpRepository } from './idp.repository';
import { Idp, IdpSchema } from './idp.schema';
import { IdpService } from './idp.service';

@Module({
    imports: [MongooseModule.forFeature([{ name: Idp.name, schema: IdpSchema }])],
    controllers: [IdpController],
    providers: [IdpRepository, IdpService]
})
export class IdpModule {}
