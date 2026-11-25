import type { Logger } from 'pino';

export interface ShutdownTarget {
    app: { close(signal?: string): Promise<void> };
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
 * Orderly shutdown on SIGTERM and SIGINT: close the Nest application (readiness turns to 503, then the HTTP
 * server stops accepting connections and waits for the requests in flight, then the MongoDB connection closes) and exit. If that takes
 * longer than timeoutMs the process exits with code 1.
 */
export const installGracefulShutdown = (target: ShutdownTarget, hooks: ShutdownHooks = {}): ((signal: string) => Promise<void>) => {
    const { app, logger, timeoutMs } = target;
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
            await app.close(signal);
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

/**
 * Until the application is up there is nothing to drain, so a signal ends the process at once. It matters in a
 * container, where the process is PID 1: without a handler it ignores SIGTERM, and a pod that waits for MongoDB
 * would keep terminating until Kubernetes kills it at the end of the grace period.
 * Returns what removes the handlers once the orderly shutdown takes over.
 */
export const exitOnSignalUntilReady = (
    hooks: { signals?: Pick<NodeJS.Process, 'on' | 'off'>; exit?: (code: number) => void } = {}
): (() => void) => {
    const source = hooks.signals ?? process;
    const exit = hooks.exit ?? ((code: number) => process.exit(code));
    const handler = (): void => exit(0);
    for (const signal of SIGNALS) {
        source.on(signal, handler);
    }
    return () => {
        for (const signal of SIGNALS) {
            source.off(signal, handler);
        }
    };
};
