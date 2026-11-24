import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { Model } from 'mongoose';
import type { AuthCacheEntry } from './auth-cache.schema';
import { AuthStore } from './auth-store';
import type { SecretBox } from './secret-box';

const idOf = (key: string): string => createHash('sha256').update(key).digest('hex');

/** Keeps everything in MongoDB, sealed, so that every instance sees the same profiles. */
export class MongoAuthStore extends AuthStore {
    private readonly logger = new Logger(MongoAuthStore.name);

    constructor(
        private readonly model: Model<AuthCacheEntry>,
        private readonly box: SecretBox,
        private readonly now: () => number = Date.now
    ) {
        super();
    }

    async get(key: string): Promise<unknown> {
        const found = await this.model.findById(idOf(key)).lean();
        if (found === null || found.expiresAt.getTime() <= this.now()) {
            return undefined;
        }
        const plain = this.box.open(found.value);
        if (plain === undefined) {
            // Sealed with another secret: it is a miss, and the next write replaces it
            this.logger.warn('A stored entry could not be opened; the secret of the store may have changed');
            return undefined;
        }
        return JSON.parse(plain) as unknown;
    }

    async set(key: string, value: unknown, ttlMs: number): Promise<void> {
        await this.model.updateOne(
            { _id: idOf(key) },
            { $set: { value: this.box.seal(JSON.stringify(value)), expiresAt: new Date(this.now() + ttlMs) } },
            { upsert: true }
        );
    }

    async delete(key: string): Promise<void> {
        await this.model.deleteOne({ _id: idOf(key) });
    }
}
