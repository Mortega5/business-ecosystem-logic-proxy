import { z } from 'zod';

// A page parameter is read as a whole number; the upstream gets that number, never the text that came
const pageNumber = (max: number) => z.coerce.number().int().min(0).max(max);

/** The page of a list, to be joined to the other filters of a query: `z.strictObject({ ...pagination, name: ... })`. */
export const pagination = { limit: pageNumber(1000).optional(), offset: pageNumber(999_999_999).optional() };

const FIELD = /^[A-Za-z][A-Za-z0-9_.]{0,60}$/;

/**
 * The order of a list, over the fields that the API lets the client sort by, or any field when none is named. The TMForum takes
 * one `sort`, with a `-` before the field for the descending order; here it is read as the field and the direction, and written
 * again by `queryParams`.
 */
export const sorting = (fields?: readonly [string, ...string[]]) => {
    const field: z.ZodType<string, string> = fields === undefined ? z.string().regex(FIELD) : z.enum(fields);
    return {
        sort: z
            .string()
            .transform((value) => ({ field: value.replace(/^-/, ''), descending: value.startsWith('-') }))
            .pipe(z.object({ field, descending: z.boolean() }))
            .optional()
    };
};

const isSort = (value: unknown): value is { field: string; descending: boolean } =>
    typeof value === 'object' && value !== null && 'field' in value && 'descending' in value;

const written = (value: unknown): string =>
    Array.isArray(value) ? (value as unknown[]).map(written).join(',') : typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value as string | number | boolean | null | undefined);

/** The query for the upstream from what was read of the one the client sent: the same filters in the same order, the numbers and the sort written again. */
export const queryParams = (sent: Record<string, unknown>, read: Record<string, unknown>): URLSearchParams => {
    const params = new URLSearchParams();
    for (const name of Object.keys(sent)) {
        const value = read[name];
        if (value !== undefined) {
            params.append(name, isSort(value) ? `${value.descending ? '-' : ''}${value.field}` : written(value));
        }
    }
    return params;
};
