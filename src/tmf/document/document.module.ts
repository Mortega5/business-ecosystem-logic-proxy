import { Module } from '@nestjs/common';
import { TmfModule } from '../tmf.module';
import { DocumentController } from './document.controller';

@Module({ imports: [TmfModule], controllers: [DocumentController] })
export class DocumentModule {}
