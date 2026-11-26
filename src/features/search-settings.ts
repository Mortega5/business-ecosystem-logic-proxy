import { Injectable, Logger } from '@nestjs/common';
import { ConfigDocumentRepository } from '../persistence/config-store/config-document.repository';

export const SEARCH_SETTINGS_DOCUMENT_ID = 'search';
const REFRESH_MS = 5000;

/**
 * What an administrator sets of the search engine: whether the keyword goes in the query of the engine (`?query=`) and not in its path. It is
 * saved in the `search` document, which v11 also keeps the address of the engine in; here the address is the one of the configuration. The
 * setting is read at most every few seconds, and a database that fails leaves the keyword in the path.
 */
@Injectable()
export class SearchSettings {
    private readonly logger = new Logger(SearchSettings.name);
    private cached: { value: boolean; expiresAt: number } | undefined;

    constructor(private readonly documents: ConfigDocumentRepository) {}

    async useQueryKeyword(): Promise<boolean> {
        if (this.cached !== undefined && this.cached.expiresAt > Date.now()) {
            return this.cached.value;
        }
        let value = false;
        try {
            const saved = (await this.documents.findById(SEARCH_SETTINGS_DOCUMENT_ID))?.['search'];
            value = typeof saved === 'object' && saved !== null && (saved as Record<string, unknown>)['useQueryKeyword'] === true;
        } catch (error) {
            this.logger.warn({ err: error }, 'The settings of the search could not be read');
        }
        this.cached = { value, expiresAt: Date.now() + REFRESH_MS };
        return value;
    }

    /** Saves the setting with the address of the engine that is in force, and fails when the database does. */
    async save(useQueryKeyword: boolean, searchUrl: string): Promise<void> {
        await this.documents.upsert(SEARCH_SETTINGS_DOCUMENT_ID, { search: { searchUrl, useQueryKeyword } });
        this.cached = undefined;
    }
}
