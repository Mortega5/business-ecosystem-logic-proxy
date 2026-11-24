import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

// The collection, the fields and the unique index are the ones of v11, so that the carts that are kept go on being there
@Schema({ collection: 'cartitems', versionKey: false })
export class CartItem {
    @Prop({ type: String, required: true })
    user!: string;

    @Prop({ type: String, required: true })
    itemId!: string;

    @Prop({ type: Object, required: true })
    itemObject!: Record<string, unknown>;
}

export const CartItemSchema = SchemaFactory.createForClass(CartItem);
CartItemSchema.index({ user: 1, itemId: 1 }, { unique: true });
