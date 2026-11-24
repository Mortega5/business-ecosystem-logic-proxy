import { describe, expect, it } from 'vitest';
import { ConfigDocumentRepository, type ConfigDocument } from '../persistence/config-store/config-document.repository';
import { SearchSettings } from './search-settings';

class Documents extends ConfigDocumentRepository {
    reads = 0;
    saved: unknown;
    broken = false;
    constructor(public stored?: ConfigDocument) {
        super();
    }
    findById(): Promise<ConfigDocument | undefined> {
        this.reads += 1;
        return this.broken ? Promise.reject(new Error('down')) : Promise.resolve(this.stored);
    }
    upsert(id: string, fields: Record<string, unknown>): Promise<void> {
        this.saved = { id, fields };
        this.stored = { id, ...fields };
        return Promise.resolve();
    }
}

describe('SearchSettings', () => {
    it('keeps the keyword in the path unless the administrator says otherwise', async () => {
        expect(await new SearchSettings(new Documents()).useQueryKeyword()).toBe(false);
        expect(await new SearchSettings(new Documents({ id: 'search', search: { searchUrl: '', useQueryKeyword: 'yes' } })).useQueryKeyword()).toBe(false);
        expect(await new SearchSettings(new Documents({ id: 'search', search: { useQueryKeyword: true } })).useQueryKeyword()).toBe(true);
    });

    it('reads the document once for a while, and again after a change', async () => {
        const documents = new Documents({ id: 'search', search: { useQueryKeyword: true } });
        const settings = new SearchSettings(documents);

        await settings.useQueryKeyword();
        await settings.useQueryKeyword();
        expect(documents.reads).toBe(1);

        await settings.save(false, '');
        expect(await settings.useQueryKeyword()).toBe(false);
        expect(documents.reads).toBe(2);
        expect(documents.saved).toEqual({ id: 'search', fields: { search: { searchUrl: '', useQueryKeyword: false } } });
    });

    it('goes on with the keyword in the path when the database cannot be read', async () => {
        const documents = new Documents({ id: 'search', search: { useQueryKeyword: true } });
        documents.broken = true;

        expect(await new SearchSettings(documents).useQueryKeyword()).toBe(false);
    });
});
