/** The collections the start-up keeps what it found in. The names are the ones of v11, so what it stored is still there. */
export type PlatformCollection = 'defaultcatalog' | 'systemcategory' | 'supportpackagespec';

export type PlatformRecord = { id: string } & Record<string, unknown>;

/** A record with the same id is already there. */
export class DuplicateRecordError extends Error {
    constructor(collection: string, id: string) {
        super(`There is already a record ${id} in ${collection}`);
        this.name = 'DuplicateRecordError';
    }
}

/** What the start-up keeps in Mongo: the id of each thing it found or made, so that it is the same one every time and in every replica. */
export abstract class PlatformRecords {
    abstract list(collection: PlatformCollection): Promise<PlatformRecord[]>;

    /** Stores a record; rejects with `DuplicateRecordError` when the id is taken and the collection has its ids unique. */
    abstract insert(collection: PlatformCollection, id: string, fields: Record<string, unknown>): Promise<void>;

    abstract update(collection: PlatformCollection, id: string, fields: Record<string, unknown>): Promise<void>;

    abstract remove(collection: PlatformCollection, id: string): Promise<void>;

    /** Makes the ids of a collection unique, which two replicas that store at once need; it does nothing when they already are. */
    abstract ensureUniqueIds(collection: PlatformCollection): Promise<void>;
}
