import { Module } from '@nestjs/common';
import { TmfModule } from '../tmf.module';
import { InventoryController } from './inventory.controller';
import { ResourceInventoryController } from './resource-inventory.controller';
import { ServiceInventoryController } from './service-inventory.controller';

@Module({ imports: [TmfModule], controllers: [InventoryController, ServiceInventoryController, ResourceInventoryController] })
export class InventoryModule {}
