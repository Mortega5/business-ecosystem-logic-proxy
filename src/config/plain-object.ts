export type PlainObject = Record<string, unknown>;

export const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export const isPlainObject = (value: unknown): value is PlainObject =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

/** Sets target[path[0]][path[1]]... creating the intermediate objects. */
export const setPath = (target: PlainObject, path: string[], value: unknown): void => {
    let cursor = target;
    for (const segment of path.slice(0, -1)) {
        const next = cursor[segment];
        if (isPlainObject(next)) {
            cursor = next;
        } else {
            const created: PlainObject = {};
            cursor[segment] = created;
            cursor = created;
        }
    }
    cursor[path[path.length - 1] as string] = value;
};
