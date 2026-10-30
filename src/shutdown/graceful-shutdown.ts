import type { Logger } from 'pino';

export interface ShutdownTarget {
    app: { close(signal?: string): Promise<void> };
    legacy: { stopBackgroundLoaders(): void; close(): Promise<void> };
    logger: Pick<Logger, 'info' | 'fatal'>;
    timeoutMs: number;
}

export interface ShutdownHooks {
    signals?: Pick<NodeJS.Process, 'on'>;
    exit?: (code: number) => void;
}

const SIGNALS = ['SIGTERM', 'SIGINT'] as const;

// A short pause lets the last log lines reach the output before the process ends
const exitSoon = (code: number): void => {
    setTimeout(() => process.exit(code), 100);
};

/**
 * Orderly shutdown on SIGTERM and SIGINT: stop the legacy background work, close the Nest application
 * (readiness turns to 503, then the HTTP server stops accepting connections and waits for the requests in
 * flight, then the Nest MongoDB connection closes), close the legacy connections and exit. If that takes
 * longer than timeoutMs the process exits with code 1.
 */
export const installGracefulShutdown = (target: ShutdownTarget, hooks: ShutdownHooks = {}): ((signal: string) => Promise<void>) => {
    const { app, legacy, logger, timeoutMs } = target;
    const exit = hooks.exit ?? exitSoon;
    let running = false;

    const shutdown = async (signal: string): Promise<void> => {
        if (running) {
            return;
        }
        running = true;
        logger.info({ signal, timeoutMs }, 'Shutting down');

        const forced = setTimeout(() => {
            logger.fatal({ timeoutMs }, 'Shutdown did not finish in time, exiting');
            exit(1);
        }, timeoutMs);
        forced.unref();

        try {
            legacy.stopBackgroundLoaders();
            await app.close(signal);
            await legacy.close();
            clearTimeout(forced);
            logger.info('Shutdown complete');
            exit(0);
        } catch (error) {
            clearTimeout(forced);
            logger.fatal({ err: error }, 'Shutdown failed');
            exit(1);
        }
    };

    const source = hooks.signals ?? process;
    for (const signal of SIGNALS) {
        source.on(signal, () => {
            void shutdown(signal);
        });
    }
    return shutdown;
};
