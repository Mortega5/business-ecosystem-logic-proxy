import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose, { type Connection, type Model } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { InMemoryRepository } from '../testing/in-memory.repository';
import { MongooseRepository } from './mongoose.repository';
import type { Repository } from './repository';

type CartItem = { user: string; itemId: string; quantity: number };

class CartItemRepository extends MongooseRepository<CartItem> {
    constructor(model: Model<CartItem>) {
        super(model);
    }
}

let mongod: MongoMemoryServer;
let connection: Connection;
let model: Model<CartItem>;

beforeAll(async () => {
    mongod = await MongoMemoryServer.create({ binary: { version: '7.0.14' } });
    connection = await mongoose.createConnection(`${mongod.getUri()}bae_contract`).asPromise();
    model = connection.model<CartItem>(
        'CartItem',
        new mongoose.Schema<CartItem>(
            { user: String, itemId: String, quantity: Number },
            { collection: 'cartitems', versionKey: false }
        )
    );
});

afterAll(async () => {
    await connection.close();
    await mongod.stop();
});

beforeEach(async () => {
    await model.deleteMany({});
});

const implementations: [string, () => Repository<CartItem>][] = [
    ['in-memory', () => new InMemoryRepository<CartItem>()],
    ['mongoose', () => new CartItemRepository(model)]
];

describe.each(implementations)('repository contract (%s)', (_name, build) => {
    it('stores and finds entities without leaking the Mongo id', async () => {
        const repository = build();
        await repository.create({ user: 'ana', itemId: '1', quantity: 2 });
        await repository.create({ user: 'ana', itemId: '2', quantity: 1 });
        await repository.create({ user: 'bob', itemId: '1', quantity: 5 });

        expect(await repository.find({ user: 'ana' })).toEqual([
            { user: 'ana', itemId: '1', quantity: 2 },
            { user: 'ana', itemId: '2', quantity: 1 }
        ]);
        expect(await repository.findOne({ user: 'bob', itemId: '1' })).toEqual({
            user: 'bob',
            itemId: '1',
            quantity: 5
        });
        expect(await repository.findOne({ user: 'nobody' })).toBeUndefined();
        expect(await repository.find()).toHaveLength(3);
    });

    it('counts what matches, or everything', async () => {
        const repository = build();
        await repository.create({ user: 'ana', itemId: '1', quantity: 2 });
        await repository.create({ user: 'ana', itemId: '2', quantity: 1 });
        await repository.create({ user: 'bob', itemId: '1', quantity: 5 });

        expect(await repository.count({ user: 'ana' })).toBe(2);
        expect(await repository.count()).toBe(3);
        await expect(repository.count({ user: { $ne: 'x' } } as unknown as { user: string })).rejects.toThrow('plain value');
    });

    it('updates the first match and reports whether there was one', async () => {
        const repository = build();
        await repository.create({ user: 'ana', itemId: '1', quantity: 2 });

        expect(await repository.updateOne({ user: 'ana', itemId: '1' }, { quantity: 9 })).toBe(true);
        expect(await repository.findOne({ user: 'ana' })).toMatchObject({ quantity: 9 });
        expect(await repository.updateOne({ user: 'zed' }, { quantity: 1 })).toBe(false);
    });

    it('deletes by filter and counts what it removed', async () => {
        const repository = build();
        await repository.create({ user: 'ana', itemId: '1', quantity: 2 });
        await repository.create({ user: 'ana', itemId: '2', quantity: 1 });
        await repository.create({ user: 'bob', itemId: '1', quantity: 5 });

        expect(await repository.deleteMany({ user: 'ana' })).toBe(2);
        expect(await repository.find()).toHaveLength(1);
    });

    it('refuses query operators smuggled in as filter values', async () => {
        const repository = build();
        await repository.create({ user: 'ana', itemId: '1', quantity: 2 });
        const injected = { user: { $ne: 'nobody' } } as unknown as { user: string };

        await expect(repository.find(injected)).rejects.toThrow('plain value');
        await expect(repository.deleteMany(injected)).rejects.toThrow('plain value');
        expect(await repository.find()).toHaveLength(1);
    });

    it('refuses operator or nested-path field names', async () => {
        const repository = build();
        await repository.create({ user: 'ana', itemId: '1', quantity: 2 });

        await expect(repository.updateOne({ user: 'ana' }, { $where: 'x' } as unknown as Partial<CartItem>)).rejects.toThrow(
            'Invalid field name'
        );
    });
});
