type Scalar = string | number | boolean | null;

/** Equality on plain values only: no operators, so request data can never turn into a query operator. */
export type Filter<T> = { [K in keyof T]?: Extract<T[K], Scalar> };

/** Base of every collection repository: an abstract class is the DI token, Mongoose and the fakes implement it. */
export abstract class Repository<T extends object> {
    abstract find(filter?: Filter<T>): Promise<T[]>;
    abstract findOne(filter: Filter<T>): Promise<T | undefined>;
    /** How many entities match; no filter counts them all. */
    abstract count(filter?: Filter<T>): Promise<number>;
    abstract create(entity: T): Promise<T>;
    /** Merges the fields into the first match; false when nothing matched. */
    abstract updateOne(filter: Filter<T>, fields: Partial<T>): Promise<boolean>;
    /** Returns how many entities were removed. */
    abstract deleteMany(filter: Filter<T>): Promise<number>;
}

const isScalar = (value: unknown): value is Scalar =>
    value === null || ['string', 'number', 'boolean'].includes(typeof value);

const assertFieldName = (name: string): void => {
    if (name === '_id' || name.startsWith('$') || name.includes('.')) {
        throw new Error(`Invalid field name "${name}"`);
    }
};

export const assertSafeFilter = (filter: object): void => {
    for (const [name, value] of Object.entries(filter)) {
        assertFieldName(name);
        if (!isScalar(value)) {
            throw new Error(`Filter on "${name}" must be a plain value`);
        }
    }
};

export const assertSafeFields = (fields: object): void => {
    Object.keys(fields).forEach(assertFieldName);
};
