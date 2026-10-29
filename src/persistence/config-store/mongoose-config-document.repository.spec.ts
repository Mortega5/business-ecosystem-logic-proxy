import { Global, Module } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/mongoose';
import { Test, type TestingModule } from '@nestjs/testing';
import { MongoClient, type Collection, type Document } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { Connection } from 'mongoose';
import { LoggerModule } from 'nestjs-pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppConfigService } from '../../config/app-config.service';
import { waitFor } from '../../testing/wait-for';
import { MongoConnectionService } from '../mongo-connection.service';
import { MongoPersistenceModule } from '../mongo-persistence.module';
import { ConfigDocumentRepository } from './config-document.repository';
import { ConfigStoreModule } from './config-store.module';

let mongod: MongoMemoryServer;
let client: MongoClient;
let collection: Collection<Document>;
let moduleRef: TestingModule;
let repository: ConfigDocumentRepository;

beforeAll(async () => {
    mongod = await MongoMemoryServer.create({ binary: { version: '7.0.14' } });
    const uri = `${mongod.getUri()}bae_test`;

    @Global()
    @Module({
        providers: [
            {
                provide: AppConfigService,
                useValue: {
                    mongo: {
                        uri,
                        maxPoolSize: 5,
                        serverSelectionTimeoutMs: 2000,
                        heartbeatFrequencyMs: 500,
                        retryInitialDelayMs: 100,
                        retryMaxDelayMs: 300
                    }
                }
            }
        ],
        exports: [AppConfigService]
    })
    class ConfigStub {}

    moduleRef = await Test.createTestingModule({
        imports: [ConfigStub, LoggerModule.forRoot({ pinoHttp: { level: 'silent' } }), MongoPersistenceModule, ConfigStoreModule]
    }).compile();
    await moduleRef.init();
    await waitFor(() => moduleRef.get(MongoConnectionService).isUp(), 15_000);
    repository = moduleRef.get(ConfigDocumentRepository);

    client = new MongoClient(uri);
    await client.connect();
    collection = client.db().collection('config');
}, 60_000);

afterAll(async () => {
    await moduleRef.close();
    await client.close();
    await mongod.stop();
});

beforeEach(async () => {
    await collection.deleteMany({});
});

describe('MongooseConfigDocumentRepository', () => {
    it('returns undefined when the document does not exist', async () => {
        await expect(repository.findById('feature-flags')).resolves.toBeUndefined();
    });

    it('reads a document stored the way the legacy proxy stores it', async () => {
        await collection.insertOne({ id: 'feature-flags', purchaseEnabled: true, quotesEnabled: false });

        await expect(repository.findById('feature-flags')).resolves.toEqual({
            id: 'feature-flags',
            purchaseEnabled: true,
            quotesEnabled: false
        });
    });

    it('creates the document and leaves it readable by the legacy format', async () => {
        await repository.upsert('search-filters', { primaryCategoriesMode: 'catalogFirstLevel', filters: [] });

        const stored = await collection.findOne({ id: 'search-filters' });
        expect(stored).toMatchObject({ id: 'search-filters', primaryCategoriesMode: 'catalogFirstLevel', filters: [] });
        expect(stored).not.toHaveProperty('__v');
        expect(await collection.countDocuments({ id: 'search-filters' })).toBe(1);
    });

    it('merges fields into an existing document without touching the others', async () => {
        await collection.insertOne({ id: 'feature-flags', purchaseEnabled: true, quotesEnabled: false });

        await repository.upsert('feature-flags', { quotesEnabled: true, dspEnabled: true });

        await expect(repository.findById('feature-flags')).resolves.toEqual({
            id: 'feature-flags',
            purchaseEnabled: true,
            quotesEnabled: true,
            dspEnabled: true
        });
        expect(await collection.countDocuments({})).toBe(1);
    });

    it.each(['$where', 'a.b', 'id', '_id'])('rejects the field name %s', async (name) => {
        await expect(repository.upsert('feature-flags', { [name]: 1 })).rejects.toThrow('Invalid configuration field');
        expect(await collection.countDocuments({})).toBe(0);
    });

    it('never builds indexes on its own', async () => {
        expect(moduleRef.get<Connection>(getConnectionToken()).config.autoIndex).toBe(false);

        await repository.upsert('feature-flags', { purchaseEnabled: true });
        await new Promise((resolve) => setTimeout(resolve, 200));

        const indexes = await collection.indexes();
        expect(indexes.map((index) => index.name)).toEqual(['_id_']);
    });
});
