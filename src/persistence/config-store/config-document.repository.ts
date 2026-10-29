export type ConfigDocument = { id: string } & Record<string, unknown>;

export abstract class ConfigDocumentRepository {
    abstract findById(id: string): Promise<ConfigDocument | undefined>;

    /** Creates the document if it does not exist and merges the given fields into it otherwise. */
    abstract upsert(id: string, fields: Record<string, unknown>): Promise<void>;
}
