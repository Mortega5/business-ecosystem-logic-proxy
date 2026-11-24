import { Module } from '@nestjs/common';
import { CartItemRepository } from '../cart/cart-item.repository';
import type { CartItem } from '../cart/cart-item.schema';
import { CartController } from '../cart/cart.controller';
import { CartService } from '../cart/cart.service';
import { InMemoryRepository } from './in-memory.repository';

/** The carts of a test, kept in memory. */
export const cartItems = new InMemoryRepository<CartItem>();

/** The cart routes as `CartModule` has them, with no database. */
@Module({
    controllers: [CartController],
    providers: [{ provide: CartItemRepository, useValue: cartItems }, CartService]
})
export class FakeCartModule {}
