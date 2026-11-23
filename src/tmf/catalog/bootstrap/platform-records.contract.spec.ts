import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose, { type Connection } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { InMemoryPlatformRecords } from '../../../testing/in-memory-platform-records';
import { MongoPlatformRecords } from './mongo-platform-records';
import { DuplicateRecordError, type PlatformCollection, type PlatformRecords } from './platform-records';

const COLLECTIONS: PlatformCollection[] = ['defaultcatalog', 'systemcategory', 'supportpackagespec'];

let mongod: MongoMemoryServer;
let connection: Connection;

beforeAll(async () => {
    mongod = await MongoMemoryServer.create({ binary: { version: '7.0.14' } });
    connection = await mongoose.createConnection(`${mongod.getUri()}bae_platform`).asPromise();
});

afterAll(async () => {
    await connection.close();
    await mongod.stop();
});

beforeEach(async () => {
    for (const name of COLLECTIONS) {
        await connection.db?.collection(name).drop().catch(() => undefined);
    }
});

// The fake of the tests of the start-up has to do what Mongo does, so both are asked the same
const implementations: [string, () => PlatformRecords][] = [
    ['in-memory', () => new InMemoryPlatformRecords()],
    ['mongo', () => new MongoPlatformRecords(connection)]
];

describe.each(implementations)('the records of the start-up (%s)', (_name, build) => {
    it('stores a record under its id and lists it without the id of Mongo', async () => {
        const records = build();

        await records.insert('defaultcatalog', 'default', { default_id: 'catalog-1' });

        expect(await records.list('defaultcatalog')).toEqual([{ id: 'default', default_id: 'catalog-1' }]);
        expect(await records.list('systemcategory')).toEqual([]);
    });

    it('changes the fields of a record and keeps the others, and removes one by its id', async () => {
        const records = build();
        await records.insert('systemcategory', 'dataset', { category_id: 'c-1', note: 'x' });
        await records.insert('systemcategory', 'api', { category_id: 'c-2' });

        await records.update('systemcategory', 'dataset', { category_id: 'c-9' });
        await records.remove('systemcategory', 'api');

        expect(await records.list('systemcategory')).toEqual([{ id: 'dataset', category_id: 'c-9', note: 'x' }]);
    });

    it('takes a second record with the same id until the ids are made unique, as v11 did, and then refuses it', async () => {
        const records = build();
        await records.insert('supportpackagespec', 'global', { spec_id: 's-1' });
        await records.insert('supportpackagespec', 'global', { spec_id: 's-2' });
        expect(await records.list('supportpackagespec')).toHaveLength(2);

        // One at a time, as a record is removed by its id
        await records.remove('supportpackagespec', 'global');
        expect(await records.list('supportpackagespec')).toHaveLength(1);
        await records.remove('supportpackagespec', 'global');
        await records.ensureUniqueIds('supportpackagespec');
        await records.ensureUniqueIds('supportpackagespec');
        await records.insert('supportpackagespec', 'global', { spec_id: 's-3' });

        await expect(records.insert('supportpackagespec', 'global', { spec_id: 's-4' })).rejects.toBeInstanceOf(DuplicateRecordError);
        expect(await records.list('supportpackagespec')).toEqual([{ id: 'global', spec_id: 's-3' }]);
    });

    it('does not mix the collections', async () => {
        const records = build();
        await records.ensureUniqueIds('defaultcatalog');
        await records.insert('defaultcatalog', 'same', { default_id: 'c-1' });

        await records.insert('systemcategory', 'same', { category_id: 'k-1' });

        expect(await records.list('defaultcatalog')).toHaveLength(1);
        expect(await records.list('systemcategory')).toHaveLength(1);
    });
});
