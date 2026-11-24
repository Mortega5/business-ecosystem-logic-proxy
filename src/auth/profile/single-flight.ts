/**
 * One piece of work per key at a time: whoever asks for a key that is being worked on waits for that work and gets its answer
 * (or its failure) instead of starting its own. It is per process; with several instances a lock outside is needed.
 */
export class SingleFlight<T> {
    private readonly running = new Map<string, Promise<T>>();

    run(key: string, work: () => Promise<T>): Promise<T> {
        const shared = this.running.get(key);
        if (shared !== undefined) {
            return shared;
        }
        const started = (async () => work())().finally(() => this.running.delete(key));
        this.running.set(key, started);
        return started;
    }
}
