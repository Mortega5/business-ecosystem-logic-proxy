import { Inject, Injectable } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import { DuplicateRecordError, PlatformRecords, type PlatformCollection, type PlatformRecord } from './platform-records';

const DUPLICATE_KEY = 11000;

// The collection of the driver that mongoose brings, whichever version it is
type RawCollection = ReturnType<NonNullable<Connection['db']>['collection']>;

@Injectable()
export class MongoPlatformRecords extends PlatformRecords {
    constructor(@Inject(getConnectionToken()) private readonly connection: Connection) {
        super();
    }

    private collection(name: PlatformCollection): RawCollection {
        if (this.connection.db === undefined) {
            throw new Error('MongoDB is not connected');
        }
        return this.connection.db.collection(name);
    }

    async list(collection: PlatformCollection): Promise<PlatformRecord[]> {
        const found = await this.collection(collection).find({}).toArray();
        return found.map(({ _id, ...record }) => {
            void _id;
            return record as PlatformRecord;
        });
    }

    async insert(collection: PlatformCollection, id: string, fields: Record<string, unknown>): Promise<void> {
        try {
            await this.collection(collection).insertOne({ ...fields, id });
        } catch (error) {
            if ((error as { code?: number }).code === DUPLICATE_KEY) {
                throw new DuplicateRecordError(collection, id);
            }
            throw error;
        }
    }

    async update(collection: PlatformCollection, id: string, fields: Record<string, unknown>): Promise<void> {
        await this.collection(collection).updateOne({ id }, { $set: fields });
    }

    async remove(collection: PlatformCollection, id: string): Promise<void> {
        await this.collection(collection).deleteOne({ id });
    }

    async ensureUniqueIds(collection: PlatformCollection): Promise<void> {
        await this.collection(collection).createIndex({ id: 1 }, { unique: true });
    }
}
