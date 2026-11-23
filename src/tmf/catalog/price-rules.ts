import { isDeepStrictEqual } from 'node:util';
import { code as currencyOf } from 'currency-codes';
import { isRecord } from '../related-party';

type Json = Record<string, unknown>;

export const CONSTRAINT = 'constraint';

const MAX_PRICE = 1_000_000_000;
const MIN_PRICE = 0.01;

/** A number, or a string that is one; nothing else is an amount, and a string that is not a number is not either. */
const numberOf = (value: unknown): number | undefined => {
    const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number.parseFloat(value) : Number.NaN;
    return Number.isFinite(parsed) ? parsed : undefined;
};

const typeOf = (price: unknown): string => (isRecord(price) && typeof price['priceType'] === 'string' ? price['priceType'].toLowerCase() : '');

/** Whether a type of price is the one of the constraints that a price plan may point at. */
export const isConstraintType = (type: unknown): boolean => typeof type === 'string' && type.toLowerCase() === CONSTRAINT;

/** Whether a price is one of those constraints. */
export const isConstraint = (price: unknown): boolean => isRecord(price) && isConstraintType(price['priceType']);

/** Whether a price is a component, which is a price of its own and not a plan or a constraint. */
export const isPlainPrice = (price: unknown): boolean => isRecord(price) && price['isBundle'] === false;

/** Whether the price is between what may be charged and has no more decimals than its currency has. */
const isValidPrice = (value: unknown, unit: unknown): boolean => {
    const price = numberOf(value);
    const currency = typeof unit === 'string' ? currencyOf(unit) : undefined;
    if (price === undefined || currency === undefined || price < MIN_PRICE || price > MAX_PRICE) {
        return false;
    }
    const decimals = price.toString().split('.')[1];
    return decimals === undefined || decimals.length <= currency.digits;
};

/** A discount is a percentage from 0 to 100 or a fixed amount that is not negative. */
const isValidDiscount = (price: Json): boolean => {
    if (price['percentage']) {
        const percentage = numberOf(price['percentage']);
        return percentage !== undefined && percentage >= 0 && percentage <= 100;
    }
    const fixed = isRecord(price['price']) ? price['price']['value'] : undefined;
    if (!fixed) {
        return true;
    }
    const amount = numberOf(fixed);
    return amount !== undefined && amount >= 0;
};

const isValidAmount = (amount: unknown): boolean => {
    const parsed = numberOf(amount);
    return parsed !== undefined && parsed >= 1;
};

/** What is wrong with the amounts of a price, or nothing when they are fine: the discount, the unit it is measured in and what it costs. */
export const amountsProblem = (price: Json): string | undefined => {
    if (typeOf(price) === 'discount' && !isValidDiscount(price)) {
        return 'Discount must be either a number or a string representing a number, percentage must be between 0 and 100 and fixed amount must be higher than 0';
    }
    if (price['unitOfMeasure'] && !isValidAmount(isRecord(price['unitOfMeasure']) ? price['unitOfMeasure']['amount'] : undefined)) {
        return 'Amount must be either a number or a string representing a number greater than 0';
    }
    if (price['price'] && !(isRecord(price['price']) && isValidPrice(price['price']['value'], price['price']['unit']))) {
        return 'Price must be either a number or a string representing a number between 0 and 1.000.000.000 and it must follow the ISO 4217 standard';
    }
    return undefined;
};

/** The field as the change sets it, and as the price had it when the change does not say. */
export const effective = (changes: Json, previous: Json | null, field: string): unknown => (changes[field] !== undefined ? changes[field] : previous?.[field]);

/** The characteristics that a price applies to. */
export const valueUsesOf = (price: unknown): Json[] => (isRecord(price) && Array.isArray(price['prodSpecCharValueUse']) ? (price['prodSpecCharValueUse'] as unknown[]).filter(isRecord) : []);

/** The constraint that a plan points at: nothing when it has none, and what is wrong when it has more than one or one without an id. */
export const constraintRefOf = (plan: Json, previous: Json | null): { ref?: Json; problem?: string } => {
    const relationships = effective(plan, previous, 'popRelationship');
    const refs = (Array.isArray(relationships) ? (relationships as unknown[]) : []).filter((relationship): relationship is Json => isRecord(relationship) && isConstraintType(relationship['relationshipType']));
    if (refs.length > 1) {
        return { problem: 'The price plan can only reference one constraint price' };
    }
    const [ref] = refs;
    if (ref !== undefined && !ref['id']) {
        return { problem: 'The price plan contains a constraint reference without an id' };
    }
    return ref === undefined ? {} : { ref };
};

const same = (first: unknown, second: unknown): boolean =>
    isRecord(first) || isRecord(second) || Array.isArray(first) || Array.isArray(second) ? isDeepStrictEqual(first, second) : String(first) === String(second);

const rangeOf = (value: unknown): [number, number] | undefined => {
    if (!isRecord(value) || value['valueFrom'] === undefined || value['valueTo'] === undefined) {
        return undefined;
    }
    return [Number(value['valueFrom']), Number(value['valueTo'])];
};

/** Whether what a price says it applies to is allowed by the characteristics that a constraint names: it cannot touch a value the constraint names. */
export const allowedByConstraint = (price: unknown, constraintUses: Json[]): boolean => {
    for (const use of valueUsesOf(price)) {
        if (!use['name']) {
            continue;
        }
        for (const constraint of constraintUses.filter((candidate) => candidate['name'] === use['name'])) {
            const forbidden = Array.isArray(constraint['productSpecCharacteristicValue']) ? (constraint['productSpecCharacteristicValue'] as unknown[]) : [];
            const used = Array.isArray(use['productSpecCharacteristicValue']) ? (use['productSpecCharacteristicValue'] as unknown[]) : [];
            if (forbidden.length === 0 || used.length === 0) {
                return false;
            }
            for (const value of used) {
                if (forbidden.some((other) => touches(value, other))) {
                    return false;
                }
            }
        }
    }
    return true;
};

/** Whether two values are the same, or two ranges that overlap; a range that is not one (it ends before it starts) overlaps nothing. */
const touches = (value: unknown, other: unknown): boolean => {
    const range = rangeOf(value);
    const forbidden = rangeOf(other);
    if (range !== undefined && forbidden !== undefined) {
        return [...range, ...forbidden].every(Number.isFinite) && range[0] <= range[1] && forbidden[0] <= forbidden[1] && range[0] <= forbidden[1] && range[1] >= forbidden[0];
    }
    return isRecord(value) && isRecord(other) && value['value'] !== undefined && other['value'] !== undefined && same(value['value'], other['value']);
};

/** Whether any of the characteristics uses is one that a compliance credential covers, which no constraint may take. */
export const usesCompliance = (price: Json): boolean => valueUsesOf(price).some((use) => String(typeof use['name'] === 'string' ? use['name'] : '').trim().toLowerCase().startsWith('compliance:'));
