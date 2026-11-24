import { AuthStore } from './auth-store';

interface Entry {
    value: unknown;
    expiresAt: number;
}

/**
 * Keeps everything in the process, as v11 did. When it is full, the entry that was written first goes; a read does not
 * renew an entry, so a profile never outlives its time because it is used.
 */
export class MemoryAuthStore extends AuthStore {
    private readonly entries = new Map<string, Entry>();

    constructor(
        private readonly maxEntries: number,
        private readonly now: () => number = Date.now
    ) {
        super();
    }

    get(key: string): Promise<unknown> {
        const entry = this.entries.get(key);
        if (entry === undefined) {
            return Promise.resolve(undefined);
        }
        if (entry.expiresAt <= this.now()) {
            this.entries.delete(key);
            return Promise.resolve(undefined);
        }
        // A copy, as a store that serialises would give: the caller cannot change what is kept
        return Promise.resolve(structuredClone(entry.value));
    }

    set(key: string, value: unknown, ttlMs: number): Promise<void> {
        // Written again, it goes to the end of the order
        this.entries.delete(key);
        this.entries.set(key, { value: structuredClone(value), expiresAt: this.now() + ttlMs });
        this.evict();
        return Promise.resolve();
    }

    delete(key: string): Promise<void> {
        this.entries.delete(key);
        return Promise.resolve();
    }

    private evict(): void {
        if (this.entries.size <= this.maxEntries) {
            return;
        }
        const now = this.now();
        // What has expired goes first, then the oldest
        for (const [key, entry] of this.entries) {
            if (entry.expiresAt <= now) {
                this.entries.delete(key);
            }
        }
        for (const key of this.entries.keys()) {
            if (this.entries.size <= this.maxEntries) {
                return;
            }
            this.entries.delete(key);
        }
    }
}
