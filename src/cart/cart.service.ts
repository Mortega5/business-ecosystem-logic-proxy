import { Injectable } from '@nestjs/common';
import { DomainError, NotFoundError } from '../common/domain-error';
import { AppConfigService } from '../config/app-config.service';
import { isRecord } from '../tmf/related-party';
import { isResourceId } from '../tmf/resource-id.pipe';
import { CartItemRepository } from './cart-item.repository';

// What a duplicate key of Mongo says, when two requests add the same item at once
const isDuplicate = (error: unknown): boolean => isRecord(error) && error['code'] === 11000;

/**
 * The shopping cart of a user: the offerings that the portal keeps for the checkout. The portal says what an item is (the offering with the
 * options chosen), and the proxy keeps it as it came and gives it back to the same user; what is bought is checked when the order is made,
 * not here. An item is known by its `id`, the one of the offering, and a user has each only once.
 */
@Injectable()
export class CartService {
    constructor(
        private readonly items: CartItemRepository,
        private readonly config: AppConfigService
    ) {}

    async list(user: string): Promise<Record<string, unknown>[]> {
        return (await this.items.find({ user })).map((item) => item.itemObject);
    }

    /** Keeps the item and returns its id. */
    async add(user: string, body: string): Promise<string> {
        const item: unknown = JSON.parse(body);
        const itemId = isRecord(item) ? item['id'] : undefined;
        if (!isRecord(item) || typeof itemId !== 'string' || itemId === '') {
            throw new DomainError('Cart Item ID missing', 400);
        }
        if (!isResourceId(itemId)) {
            throw new DomainError('Invalid Cart Item ID', 400);
        }
        if (await this.items.findOne({ user, itemId })) {
            throw new DomainError('This item is already in your shopping cart', 409);
        }
        if ((await this.items.count({ user })) >= this.config.limits.cartItems) {
            throw new DomainError('Your shopping cart is full', 409);
        }
        try {
            await this.items.create({ user, itemId, itemObject: item });
        } catch (error) {
            if (isDuplicate(error)) {
                throw new DomainError('This item is already in your shopping cart', 409);
            }
            throw error;
        }
        return itemId;
    }

    async remove(user: string, itemId: string): Promise<void> {
        if ((await this.items.deleteMany({ user, itemId })) === 0) {
            throw new NotFoundError('The given ordering item cannot be deleted since it was not present in your cart');
        }
    }

    async empty(user: string): Promise<void> {
        await this.items.deleteMany({ user });
    }
}
