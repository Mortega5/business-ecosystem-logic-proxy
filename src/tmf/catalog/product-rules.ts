import { isDeepStrictEqual } from 'node:util';
import { isRecord } from '../related-party';

type Json = Record<string, unknown>;

const DIGITAL = ['asset type', 'media type', 'location'];
const COMPLIANCE = 'compliance:vc';

const nameOf = (characteristic: unknown): string => (isRecord(characteristic) && typeof characteristic['name'] === 'string' ? characteristic['name'].trim().toLowerCase() : '');

const listOf = (value: unknown): unknown[] => (Array.isArray(value) ? (value as unknown[]) : []);

/** Whether a range goes from a value that is not below where it ends, which is no range. */
const isEmptyRange = (value: unknown): boolean => isRecord(value) && 'valueFrom' in value && 'valueTo' in value && Number(value['valueFrom']) >= Number(value['valueTo']);

const isRange = (value: unknown): boolean => isRecord(value) && 'valueFrom' in value && 'valueTo' in value;

/**
 * Whether the characteristics of a product are fine: no name and no id twice, ranges that are ranges (one range per characteristic,
 * and not an empty one), and the compliance credential, which is not made here, as it was before. On a create there is no credential
 * to keep, so it cannot come in at all.
 */
export const validCharacteristics = (characteristics: unknown, previous: unknown[] | null): boolean => {
    if (!Array.isArray(characteristics)) {
        return false;
    }
    const names = new Set<unknown>();
    const ids = new Set<unknown>();
    const credentials: unknown[] = [];
    for (const characteristic of characteristics as unknown[]) {
        if (!isRecord(characteristic) || names.has(characteristic['name']) || (characteristic['id'] && ids.has(characteristic['id']))) {
            return false;
        }
        if (nameOf(characteristic) === COMPLIANCE) {
            credentials.push(characteristic);
        }
        const values = listOf(characteristic['productSpecCharacteristicValue']);
        if ((values.length === 1 && isEmptyRange(values[0])) || (values.length > 1 && isRange(values[0]))) {
            return false;
        }
        names.add(characteristic['name']);
        if (characteristic['id']) {
            ids.add(characteristic['id']);
        }
    }
    const before = previous === null ? null : previous.filter((characteristic) => nameOf(characteristic) === COMPLIANCE);
    return before === null ? credentials.length === 0 : isDeepStrictEqual(credentials, before);
};

/** Whether the characteristics are those of a digital product, which has an asset behind it: its type, its media type and where it is. */
export const isDigital = (characteristics: unknown): boolean => {
    const names = new Set(listOf(characteristics).map(nameOf));
    return DIGITAL.every((name) => names.has(name));
};

/** Whether two products have the same characteristics that are not about the asset. */
export const sameCustomCharacteristics = (first: unknown, second: unknown): boolean => {
    const custom = (characteristics: unknown): unknown[] => listOf(characteristics).filter((characteristic) => !DIGITAL.includes(nameOf(characteristic)));
    return isDeepStrictEqual(custom(first), custom(second));
};

/** The ids of the characteristics that the product has and the changes leave out; nothing is removed when the changes do not send them. */
export const removedCharacteristicIds = (current: Json, changes: Json): string[] => {
    if (!Array.isArray(changes['productSpecCharacteristic'])) {
        return [];
    }
    const kept = new Set(listOf(changes['productSpecCharacteristic']).flatMap((characteristic) => (isRecord(characteristic) && characteristic['id'] ? [characteristic['id']] : [])));
    return listOf(current['productSpecCharacteristic']).flatMap((characteristic) =>
        isRecord(characteristic) && typeof characteristic['id'] === 'string' && characteristic['id'] !== '' && !kept.has(characteristic['id']) ? [characteristic['id']] : []
    );
};

const sameVersion = (first: unknown, second: unknown): boolean => JSON.stringify(first) === JSON.stringify(second);

/** What the charging backend is told when a digital product gets a new version: nothing when it does not, as when it only changes. */
export const upgradeOf = (current: Json, changes: Json): { id: string; version: unknown; productSpecCharacteristic: unknown } | undefined => {
    const version = changes['version'];
    if (
        !isDigital(current['productSpecCharacteristic']) ||
        !version ||
        sameVersion(version, current['version']) ||
        !changes['productSpecCharacteristic'] ||
        !isDigital(changes['productSpecCharacteristic'])
    ) {
        return undefined;
    }
    return { id: String(current['id']), version, productSpecCharacteristic: changes['productSpecCharacteristic'] };
};
