import { createHash } from 'node:crypto';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose, { type Connection, type Model } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuthCacheEntry, AuthCacheEntrySchema } from './auth-cache.schema';
import { MongoAuthStore } from './mongo-auth-store';
import { SecretBox } from './secret-box';

let mongod: MongoMemoryServer;
let connection: Connection;
let model: Model<AuthCacheEntry>;
let time = 1_000_000;
const now = (): number => time;
const SECRET = 's'.repeat(40);

beforeAll(async () => {
    mongod = await MongoMemoryServer.create({ binary: { version: '7.0.14' } });
    connection = await mongoose.createConnection(`${mongod.getUri()}bae_test`).asPromise();
    model = connection.model(AuthCacheEntry.name, AuthCacheEntrySchema) as unknown as Model<AuthCacheEntry>;
    await model.init();
});

afterAll(async () => {
    await connection.close();
    await mongod.stop();
});

beforeEach(async () => {
    time = 1_000_000;
    await model.deleteMany({});
});

const store = (secret = SECRET): MongoAuthStore => new MongoAuthStore(model, new SecretBox(secret), now);

describe('MongoAuthStore', () => {
    it('gives back what was stored, and nothing for a key it does not have', async () => {
        await store().set('profile:token-1', { id: 'u1', refreshToken: 'r1', roles: [{ name: 'seller' }] }, 1000);

        expect(await store().get('profile:token-1')).toEqual({ id: 'u1', refreshToken: 'r1', roles: [{ name: 'seller' }] });
        expect(await store().get('profile:other')).toBeUndefined();
    });

    it('stores neither the key nor the value in the clear', async () => {
        await store().set('profile:the-access-token', { refreshToken: 'the-refresh-token' }, 1000);

        const [document] = await model.find().lean();
        expect(document?._id).toBe(createHash('sha256').update('profile:the-access-token').digest('hex'));
        expect(JSON.stringify(document)).not.toContain('the-access-token');
        expect(JSON.stringify(document)).not.toContain('the-refresh-token');
    });

    it('does not give a value whose time is over, even if Mongo has not removed it yet', async () => {
        await store().set('k', 'v', 1000);

        time += 999;
        expect(await store().get('k')).toBe('v');
        time += 1;
        expect(await store().get('k')).toBeUndefined();
    });

    it('lets Mongo remove what expires, with an index on the date', async () => {
        const indexes = await model.collection.indexes();

        expect(indexes.some((index) => index.key['expiresAt'] === 1 && index.expireAfterSeconds === 0)).toBe(true);
    });

    it('replaces a value written again, with its new time', async () => {
        await store().set('k', 'first', 1000);
        await store().set('k', 'second', 5000);

        time += 2000;
        expect(await store().get('k')).toBe('second');
        expect(await model.countDocuments()).toBe(1);
    });

    it('takes an entry sealed with another secret as a miss, and replaces it on the next write', async () => {
        await store('x'.repeat(40)).set('k', 'v', 1000);

        expect(await store().get('k')).toBeUndefined();
        await store().set('k', 'w', 1000);
        expect(await store().get('k')).toBe('w');
    });

    it('deletes a key, and does not mind one that is not there', async () => {
        await store().set('k', 'v', 1000);
        await store().delete('k');
        await store().delete('nothing');

        expect(await store().get('k')).toBeUndefined();
    });
});
