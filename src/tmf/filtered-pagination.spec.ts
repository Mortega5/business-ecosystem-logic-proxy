import { describe, expect, it, vi } from 'vitest';
import { decodeToken, encodeToken, paginate } from './filtered-pagination';

const ITEMS = Array.from({ length: 10 }, (_, index) => ({ n: index }));
const even = (item: unknown) => (item as { n: number }).n % 2 === 0;
const source = (items: unknown[]) => vi.fn((offset: number, limit: number) => Promise.resolve(items.slice(offset, offset + limit)));

describe('paginate', () => {
    it('fills a page with the items that pass, reading the upstream as far as it needs', async () => {
        const fetchPage = source(ITEMS);

        const page = await paginate({ limit: 3, offset: 0, fingerprint: 'q', fetchPage, predicate: even, maxScanned: 10_000 });

        expect(page.items).toEqual([{ n: 0 }, { n: 2 }, { n: 4 }]);
        expect(decodeToken(page.token as string)).toEqual({ offset: 5, fingerprint: 'q' });
    });

    it('goes on from the token, and has none when the upstream is read to its end', async () => {
        const first = await paginate({ limit: 3, offset: 0, fingerprint: 'q', fetchPage: source(ITEMS), predicate: even, maxScanned: 10_000 });
        const second = await paginate({ limit: 3, offset: 0, token: first.token as string, fingerprint: 'q', fetchPage: source(ITEMS), predicate: even, maxScanned: 10_000 });

        expect(second.items).toEqual([{ n: 6 }, { n: 8 }]);
        expect(second.token).toBeUndefined();
    });

    it('starts at the offset when there is no token', async () => {
        const page = await paginate({ limit: 5, offset: 4, fingerprint: 'q', fetchPage: source(ITEMS), predicate: even, maxScanned: 10_000 });

        expect(page.items).toEqual([{ n: 4 }, { n: 6 }, { n: 8 }]);
    });

    it('refuses a token of another query, one that is not a token, and a limit that is not positive', async () => {
        const token = encodeToken(2, 'other');

        await expect(paginate({ limit: 3, offset: 0, token, fingerprint: 'q', fetchPage: source(ITEMS), predicate: even, maxScanned: 10_000 })).rejects.toMatchObject({ status: 400 });
        await expect(paginate({ limit: 3, offset: 0, token: 'not a token', fingerprint: 'q', fetchPage: source(ITEMS), predicate: even, maxScanned: 10_000 })).rejects.toMatchObject({ status: 400 });
        await expect(paginate({ limit: 3, offset: 0, token: Buffer.from('{"offset":-1}').toString('base64url'), fingerprint: 'q', fetchPage: source(ITEMS), predicate: even, maxScanned: 10_000 })).rejects.toMatchObject({ status: 400 });
        await expect(paginate({ limit: 0, offset: 0, fingerprint: 'q', fetchPage: source(ITEMS), predicate: even, maxScanned: 10_000 })).rejects.toMatchObject({ status: 400 });
    });

    it('stops scanning when nothing passes, and gives the token to go on', async () => {
        const fetchPage = vi.fn((_offset: number, limit: number) => Promise.resolve(Array.from({ length: limit }, () => ({ n: 1 }))));

        const page = await paginate({ limit: 100, offset: 0, fingerprint: 'q', fetchPage, predicate: even, maxScanned: 10_000 });

        expect(page.items).toEqual([]);
        expect(fetchPage).toHaveBeenCalledTimes(100);
        expect(decodeToken(page.token as string).offset).toBe(10_000);
    });
});
