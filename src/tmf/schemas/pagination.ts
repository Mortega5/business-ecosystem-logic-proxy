import { z } from 'zod';

// A page parameter is read as a whole number, up to nine digits as in the rest of the proxy; the upstream gets that number, never the text that came
const pageNumber = z.coerce.number().int().min(0).max(999_999_999);

/** The page of a list, to be joined to the other filters of a query: `z.strictObject({ ...pagination, name: ... })`. */
export const pagination = { limit: pageNumber.optional(), offset: pageNumber.optional() };

/**
 * The order of a list, over the fields that the API lets the client sort by. The TMForum takes one `sort`, with a `-` before the field
 * for the descending order; here it is read as the field and the direction, and written again by `pageParams`.
 */
export const sorting = <const Fields extends readonly [string, ...string[]]>(fields: Fields) => ({
    sort: z
        .string()
        .transform((value) => ({ field: value.replace(/^-/, ''), descending: value.startsWith('-') }))
        .pipe(z.object({ field: z.enum(fields), descending: z.boolean() }))
        .optional()
});

export interface Page {
    limit?: number | undefined;
    offset?: number | undefined;
    sort?: { field: string; descending: boolean } | undefined;
}

/** The parameters of a query for a page that was read, in the order limit, offset, sort. */
export const pageParams = (page: Page): [string, string][] => [
    ...(page.limit === undefined ? [] : ([['limit', String(page.limit)]] as [string, string][])),
    ...(page.offset === undefined ? [] : ([['offset', String(page.offset)]] as [string, string][])),
    ...(page.sort === undefined ? [] : ([['sort', `${page.sort.descending ? '-' : ''}${page.sort.field}`]] as [string, string][]))
];
