import { Global, Module } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { getConnectionToken } from '@nestjs/mongoose';
import { LoggerModule } from 'nestjs-pino';
import { Schema, type Connection } from 'mongoose';
import { afterEach, describe, expect, it } from 'vitest';
import { AppConfigService } from '../config/app-config.service';
import { ManagedMongod } from '../testing/managed-mongod';
import { waitFor } from '../testing/wait-for';
import { ConfigDocumentRepository } from './config-store/config-document.repository';
import { ConfigStoreModule } from './config-store/config-store.module';
import { MongoConnectionService, mongoTarget } from './mongo-connection.service';
import { MongoPersistenceModule } from './mongo-persistence.module';

const buildModule = async (mongod: ManagedMongod): Promise<TestingModule> => {
    @Global()
    @Module({
        providers: [
            {
                provide: AppConfigService,
                useValue: {
                    mongo: {
                        uri: `${mongod.uri}/bae_outage`,
                        maxPoolSize: 5,
                        serverSelectionTimeoutMs: 500,
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

    const module = await Test.createTestingModule({
        imports: [ConfigStub, LoggerModule.forRoot({ pinoHttp: { level: 'silent' } }), MongoPersistenceModule, ConfigStoreModule]
    }).compile();
    await module.init();
    return module;
};

describe('MongoConnectionService', () => {
    const cleanup: (() => Promise<unknown>)[] = [];
    afterEach(async () => {
        for (const task of cleanup.splice(0).reverse()) {
            await task();
        }
    });

    const setup = async (): Promise<{ mongod: ManagedMongod; module: TestingModule; service: MongoConnectionService }> => {
        const mongod = await ManagedMongod.create();
        cleanup.push(() => mongod.destroy());
        const module = await buildModule(mongod);
        cleanup.push(() => module.close());
        return { mongod, module, service: module.get(MongoConnectionService) };
    };

    it('starts while Mongo is down, keeps retrying and connects once it is available', async () => {
        const { mongod, module, service } = await setup();
        expect(service.isUp()).toBe(false);
        expect(await service.ping(200)).toBe(false);

        await mongod.start();
        await waitFor(() => service.isUp(), 20_000);
        await expect(service.whenUp()).resolves.toBeUndefined();

        const repository = module.get(ConfigDocumentRepository);
        await repository.upsert('feature-flags', { purchaseEnabled: true });
        await expect(repository.findById('feature-flags')).resolves.toMatchObject({ purchaseEnabled: true });
    }, 40_000);

    it('makes the indexes of the models once it is connected', async () => {
        const { mongod, module, service } = await setup();
        const connection = module.get<Connection>(getConnectionToken());
        connection.model('IndexProbe', new Schema({ key: { type: String } }, { collection: 'index_probe' }).index({ key: 1 }, { unique: true }));

        await mongod.start();
        await waitFor(() => service.isUp(), 20_000);
        await waitFor(async () => (await connection.collection('index_probe').indexes().catch(() => [])).some((index) => index.unique === true), 10_000);
    }, 40_000);

    it('notices an outage while running and recovers when Mongo comes back', async () => {
        const { mongod, module, service } = await setup();
        await mongod.start();
        await waitFor(() => service.isUp(), 15_000);
        const repository = module.get(ConfigDocumentRepository);
        await repository.upsert('feature-flags', { purchaseEnabled: true });
        expect(await service.ping(1000)).toBe(true);

        await mongod.stop();
        await waitFor(async () => !service.isUp() || !(await service.ping(300)), 15_000);
        expect(await service.ping(300)).toBe(false);

        await mongod.start();
        await waitFor(async () => service.isUp() && (await service.ping(1000)), 30_000);

        await repository.upsert('feature-flags', { quotesEnabled: true });
        await expect(repository.findById('feature-flags')).resolves.toMatchObject({
            purchaseEnabled: true,
            quotesEnabled: true
        });
    }, 90_000);

    it('stops retrying when the application shuts down', async () => {
        const { module } = await setup();
        await new Promise((resolve) => setTimeout(resolve, 600));

        const started = Date.now();
        await module.close();

        expect(Date.now() - started).toBeLessThan(2000);
    }, 20_000);
});

describe('mongoTarget', () => {
    it('keeps the address and the database, and drops the credentials and the options', () => {
        expect(mongoTarget('mongodb://localhost:27017/belp')).toBe('mongodb://localhost:27017/belp');
        expect(mongoTarget('mongodb://ana:s3cret@db1:27017,db2:27017/belp?replicaSet=rs&tlsCertificateKeyFilePassword=x')).toBe(
            'mongodb://db1:27017,db2:27017/belp'
        );
        expect(mongoTarget('mongodb+srv://ana:p%40ss@cluster.example.org/belp')).toBe('mongodb+srv://cluster.example.org/belp');
    });
});
