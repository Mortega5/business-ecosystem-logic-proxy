import { Inject, Injectable } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/mongoose';
import { ConnectionStates, type Connection } from 'mongoose';
import { DuplicateRecordError, PlatformRecords, type PlatformCollection, type PlatformRecord } from './platform-records';

const DUPLICATE_KEY = 11000;

// The collection of the driver that mongoose brings, whichever version it is
type RawCollection = ReturnType<NonNullable<Connection['db']>['collection']>;

@Injectable()
export class MongoPlatformRecords extends PlatformRecords {
    constructor(@Inject(getConnectionToken()) private readonly connection: Connection) {
        super();
    }

    // The connection is made in the background when the server starts, so the first use may come before it is up: it waits for it,
    // and the connection service says in the log what it is doing meanwhile
    private async collection(name: PlatformCollection): Promise<RawCollection> {
        if (this.connection.readyState !== ConnectionStates.connected) {
            await new Promise<void>((resolve) => this.connection.once('connected', () => resolve()));
        }
        if (this.connection.db === undefined) {
            throw new Error('MongoDB is not connected');
        }
        return this.connection.db.collection(name);
    }

    async list(collection: PlatformCollection): Promise<PlatformRecord[]> {
        const found = await (await this.collection(collection)).find({}).toArray();
        return found.map(({ _id, ...record }) => {
            void _id;
            return record as PlatformRecord;
        });
    }

    async insert(collection: PlatformCollection, id: string, fields: Record<string, unknown>): Promise<void> {
        try {
            await (await this.collection(collection)).insertOne({ ...fields, id });
        } catch (error) {
            if ((error as { code?: number }).code === DUPLICATE_KEY) {
                throw new DuplicateRecordError(collection, id);
            }
            throw error;
        }
    }

    async update(collection: PlatformCollection, id: string, fields: Record<string, unknown>): Promise<void> {
        await (await this.collection(collection)).updateOne({ id }, { $set: fields });
    }

    async remove(collection: PlatformCollection, id: string): Promise<void> {
        await (await this.collection(collection)).deleteOne({ id });
    }

    async ensureUniqueIds(collection: PlatformCollection): Promise<void> {
        await (await this.collection(collection)).createIndex({ id: 1 }, { unique: true });
    }
}
