import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { ConfigDocumentRepository, type ConfigDocument } from './config-document.repository';
import { ConfigEntry } from './config-entry.schema';

const assertSafeFieldName = (name: string): void => {
    if (name === 'id' || name === '_id' || name.startsWith('$') || name.includes('.')) {
        throw new Error(`Invalid configuration field name "${name}"`);
    }
};

@Injectable()
export class MongooseConfigDocumentRepository extends ConfigDocumentRepository {
    constructor(@InjectModel(ConfigEntry.name) private readonly model: Model<ConfigEntry>) {
        super();
    }

    async findById(id: string): Promise<ConfigDocument | undefined> {
        const found = await this.model.findOne({ id }).lean<Record<string, unknown>>();
        if (found === null) {
            return undefined;
        }
        const { _id, ...document } = found;
        void _id;
        return document as ConfigDocument;
    }

    async upsert(id: string, fields: Record<string, unknown>): Promise<void> {
        Object.keys(fields).forEach(assertSafeFieldName);
        await this.model.updateOne({ id }, { $set: fields }, { upsert: true, strict: false });
    }
}
