import type { Connection } from 'mongoose';
import { describe, expect, it } from 'vitest';
import type { AppConfigService } from '../config/app-config.service';
import { createAuthStore } from './auth.module';
import { MemoryAuthStore } from './store/memory-auth-store';
import { MongoAuthStore } from './store/mongo-auth-store';

const configWith = (store: { type: 'memory' | 'mongo'; memoryMaxEntries: number; encryptionKey?: string }): AppConfigService =>
    ({ auth: { store } }) as AppConfigService;
const connection = { model: () => ({}) } as unknown as Connection;

describe('createAuthStore', () => {
    it('keeps the profiles in memory by default', () => {
        expect(createAuthStore(configWith({ type: 'memory', memoryMaxEntries: 10 }), connection)).toBeInstanceOf(MemoryAuthStore);
    });

    it('keeps them in MongoDB when it is chosen', () => {
        const store = createAuthStore(configWith({ type: 'mongo', memoryMaxEntries: 10, encryptionKey: 'k'.repeat(32) }), connection);

        expect(store).toBeInstanceOf(MongoAuthStore);
    });

    it('refuses MongoDB when there is no connection', () => {
        const config = configWith({ type: 'mongo', memoryMaxEntries: 10, encryptionKey: 'k'.repeat(32) });

        expect(() => createAuthStore(config, undefined)).toThrow('connection');
    });

    it('needs no connection for the memory store', () => {
        expect(createAuthStore(configWith({ type: 'memory', memoryMaxEntries: 10 }), undefined)).toBeInstanceOf(MemoryAuthStore);
    });

    it('refuses MongoDB without the key, whatever the configuration said', () => {
        expect(() => createAuthStore(configWith({ type: 'mongo', memoryMaxEntries: 10 }), connection)).toThrow('encryptionKey');
    });
});
