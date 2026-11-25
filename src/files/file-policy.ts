/**
 * What the access policy of a product specification can reach under the files prefix. The portal writes the policy; the proxy only
 * reads which files it names, to check that they are the seller's.
 */
const POLICY_VALUE_TYPE = 'authorizationPolicy';
const FILE_PATH_PREFIX = '/private/';

// What the file service calls a file id, and the characters that turn a path into a pattern
const FILE_ID_AT_START = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;
const PATTERN_CHARS = /[*+?[({|\\]/;
const FILE_ID_START = /^[0-9a-f-]*$/i;

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Every string in the access policy of a product specification that names a path under the files prefix. */
export const filePathsIn = (spec: unknown): string[] => {
    const found: string[] = [];
    const visit = (value: unknown): void => {
        if (typeof value === 'string') {
            if (value.includes(FILE_PATH_PREFIX)) {
                found.push(value);
            }
        } else if (Array.isArray(value)) {
            value.forEach(visit);
        } else if (isRecord(value)) {
            Object.values(value).forEach(visit);
        }
    };
    const characteristics = isRecord(spec) && Array.isArray(spec['productSpecCharacteristic']) ? spec['productSpecCharacteristic'] : [];
    for (const characteristic of characteristics) {
        if (isRecord(characteristic) && characteristic['valueType'] === POLICY_VALUE_TYPE) {
            visit(characteristic['productSpecCharacteristicValue']);
        }
    }
    return found;
};

/**
 * What the access policy of a product specification can reach under the files prefix:
 * - `ids`: the files it names, by their id (a string that starts with an id names it);
 * - `wide`: the strings that could match files without naming one: no id at all, a pattern, or only the start of an id. Anything
 *   else under the prefix cannot be a file of the file service.
 */
export const fileTargetsIn = (spec: unknown): { ids: string[]; wide: string[] } => {
    const ids: string[] = [];
    const wide: string[] = [];
    for (const path of filePathsIn(spec)) {
        for (const rest of path.split(FILE_PATH_PREFIX).slice(1)) {
            const named = FILE_ID_AT_START.exec(rest);
            if (named !== null) {
                // Whatever follows the id (an anchor, a slash...), it is that file that is named
                ids.push(named[0].toLowerCase());
            } else if (rest === '' || PATTERN_CHARS.test(rest) || FILE_ID_START.test(rest)) {
                wide.push(path);
            }
        }
    }
    return { ids, wide };
};
