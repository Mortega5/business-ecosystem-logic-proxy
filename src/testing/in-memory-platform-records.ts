import { DuplicateRecordError, PlatformRecords, type PlatformCollection, type PlatformRecord } from '../tmf/catalog/bootstrap/platform-records';

/** Fake for the tests of the start-up; the ids of a collection are unique once it is asked to make them so, as in Mongo. */
export class InMemoryPlatformRecords extends PlatformRecords {
    readonly records: Record<PlatformCollection, PlatformRecord[]> = { defaultcatalog: [], systemcategory: [], supportpackagespec: [] };
    private readonly unique = new Set<PlatformCollection>();

    list(collection: PlatformCollection): Promise<PlatformRecord[]> {
        return Promise.resolve(this.records[collection].map((record) => ({ ...record })));
    }

    insert(collection: PlatformCollection, id: string, fields: Record<string, unknown>): Promise<void> {
        if (this.unique.has(collection) && this.records[collection].some((record) => record.id === id)) {
            return Promise.reject(new DuplicateRecordError(collection, id));
        }
        this.records[collection].push({ ...fields, id });
        return Promise.resolve();
    }

    update(collection: PlatformCollection, id: string, fields: Record<string, unknown>): Promise<void> {
        const target = this.records[collection].find((record) => record.id === id);
        if (target !== undefined) {
            Object.assign(target, fields);
        }
        return Promise.resolve();
    }

    remove(collection: PlatformCollection, id: string): Promise<void> {
        this.records[collection] = this.records[collection].filter((record) => record.id !== id);
        return Promise.resolve();
    }

    ensureUniqueIds(collection: PlatformCollection): Promise<void> {
        this.unique.add(collection);
        return Promise.resolve();
    }
}
