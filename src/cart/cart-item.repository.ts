import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { MongooseRepository } from '../persistence/mongoose.repository';
import { CartItem } from './cart-item.schema';

@Injectable()
export class CartItemRepository extends MongooseRepository<CartItem> {
    constructor(@InjectModel(CartItem.name) model: Model<CartItem>) {
        super(model);
    }
}
