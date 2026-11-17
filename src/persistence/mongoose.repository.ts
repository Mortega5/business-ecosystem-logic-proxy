import type { Model } from 'mongoose';
import { assertSafeFields, assertSafeFilter, Repository, type Filter } from './repository';

const withoutMongoId = <T>(raw: Record<string, unknown>): T => {
    const { _id, ...rest } = raw;
    void _id;
    return rest as T;
};

/** Generic Mongoose implementation; a concrete repository only names its model. */
export abstract class MongooseRepository<T extends object> extends Repository<T> {
    protected constructor(protected readonly model: Model<T>) {
        super();
    }

    async find(filter: Filter<T> = {}): Promise<T[]> {
        assertSafeFilter(filter);
        const found = await this.model.find(filter).lean<Record<string, unknown>[]>();
        return found.map((raw) => withoutMongoId<T>(raw));
    }

    async findOne(filter: Filter<T>): Promise<T | undefined> {
        assertSafeFilter(filter);
        const found = await this.model.findOne(filter).lean<Record<string, unknown>>();
        return found === null ? undefined : withoutMongoId<T>(found);
    }

    async create(entity: T): Promise<T> {
        const created = await this.model.create(entity);
        return withoutMongoId<T>(created.toObject() as Record<string, unknown>);
    }

    async updateOne(filter: Filter<T>, fields: Partial<T>): Promise<boolean> {
        assertSafeFilter(filter);
        assertSafeFields(fields);
        const result = await this.model.updateOne(filter, { $set: fields });
        return result.matchedCount > 0;
    }

    async deleteMany(filter: Filter<T>): Promise<number> {
        assertSafeFilter(filter);
        const result = await this.model.deleteMany(filter);
        return result.deletedCount;
    }
}
