import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CartItem, CartItemSchema } from './cart-item.schema';
import { CartItemRepository } from './cart-item.repository';
import { CartController } from './cart.controller';
import { CartService } from './cart.service';

@Module({
    imports: [MongooseModule.forFeature([{ name: CartItem.name, schema: CartItemSchema }])],
    controllers: [CartController],
    providers: [CartItemRepository, CartService]
})
export class CartModule {}
