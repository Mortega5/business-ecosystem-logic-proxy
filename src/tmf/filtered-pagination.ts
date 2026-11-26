import { DomainError } from '../common/domain-error';

export const TOKEN_HEADER = 'x-filtered-pagination-token';

interface Token {
    offset: number;
    fingerprint?: string;
}

export interface FilteredPage {
    items: unknown[];
    /** Where the next page starts; absent when the upstream has nothing more. */
    token?: string;
}

export interface FilteredPagination {
    limit: number;
    /** Where to start when the client has no token. */
    offset: number;
    /** The token of the previous page, as the client sent it. */
    token?: string;
    /** What the query is, so a token of another query is refused. */
    fingerprint: string;
    /** The page of the upstream that starts at `offset`, without the filter. */
    fetchPage: (offset: number, limit: number) => Promise<unknown[]>;
    predicate: (item: unknown) => boolean | Promise<boolean>;
    /** The items it looks at before it gives what it has and the token to go on, so one query cannot scan everything. */
    maxScanned: number;
}

export const encodeToken = (offset: number, fingerprint: string): string => Buffer.from(JSON.stringify({ offset, fingerprint } satisfies Token)).toString('base64url');

export const decodeToken = (token: string): Token => {
    try {
        const decoded: unknown = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
        const { offset, fingerprint } = decoded as Partial<Token>;
        if (typeof offset === 'number' && Number.isSafeInteger(offset) && offset >= 0 && (fingerprint === undefined || typeof fingerprint === 'string')) {
            return { offset, ...(fingerprint === undefined ? {} : { fingerprint }) };
        }
    } catch {
        // Falls to the refusal
    }
    throw new DomainError('Invalid filtered pagination token', 400);
};

/**
 * A page of items that pass a filter the upstream cannot apply: it reads the upstream in pages until the page is full or there
 * is no more, and gives the token to go on from the last item it looked at.
 */
export const paginate = async (options: FilteredPagination): Promise<FilteredPage> => {
    if (!Number.isSafeInteger(options.limit) || options.limit <= 0) {
        throw new DomainError('Filtered pagination requires a positive limit', 400);
    }
    let offset = options.offset;
    if (options.token !== undefined) {
        const decoded = decodeToken(options.token);
        if (decoded.fingerprint !== options.fingerprint) {
            throw new DomainError('Invalid filtered pagination token', 400);
        }
        offset = decoded.offset;
    }
    const start = offset;
    const items: unknown[] = [];
    let exhausted = false;
    while (items.length < options.limit && !exhausted) {
        if (offset - start >= options.maxScanned) {
            break;
        }
        const page = await options.fetchPage(offset, options.limit);
        if (page.length === 0) {
            exhausted = true;
            break;
        }
        let read = 0;
        while (read < page.length && items.length < options.limit) {
            const item = page[read];
            read += 1;
            offset += 1;
            if (await options.predicate(item)) {
                items.push(item);
            }
        }
        if (read === page.length && page.length < options.limit) {
            exhausted = true;
        }
    }
    return exhausted ? { items } : { items, token: encodeToken(offset, options.fingerprint) };
};
