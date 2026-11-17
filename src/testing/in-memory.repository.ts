import { assertSafeFields, assertSafeFilter, Repository, type Filter } from '../persistence/repository';

/** Fake for service tests; follows the same rules as the Mongoose repository, including the filter checks. */
export class InMemoryRepository<T extends object> extends Repository<T> {
    private entities: T[] = [];

    private matches(entity: T, filter: Filter<T>): boolean {
        assertSafeFilter(filter);
        return Object.entries(filter).every(([name, value]) => (entity as Record<string, unknown>)[name] === value);
    }

    async find(filter: Filter<T> = {}): Promise<T[]> {
        return this.entities.filter((entity) => this.matches(entity, filter)).map((entity) => ({ ...entity }));
    }

    async findOne(filter: Filter<T>): Promise<T | undefined> {
        return (await this.find(filter))[0];
    }

    async create(entity: T): Promise<T> {
        this.entities.push({ ...entity });
        return { ...entity };
    }

    async updateOne(filter: Filter<T>, fields: Partial<T>): Promise<boolean> {
        assertSafeFields(fields);
        const target = this.entities.find((entity) => this.matches(entity, filter));
        if (target !== undefined) {
            Object.assign(target, fields);
        }
        return target !== undefined;
    }

    async deleteMany(filter: Filter<T>): Promise<number> {
        const before = this.entities.length;
        this.entities = this.entities.filter((entity) => !this.matches(entity, filter));
        return before - this.entities.length;
    }
}
