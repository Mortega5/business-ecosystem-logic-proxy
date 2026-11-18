import { Module } from '@nestjs/common';
import { TmfModule } from '../tmf.module';
import { AccountController } from './account.controller';

@Module({ imports: [TmfModule], controllers: [AccountController] })
export class AccountModule {}
