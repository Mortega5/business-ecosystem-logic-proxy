import type { Logger } from 'pino';

export interface CrashHooks {
    events?: Pick<NodeJS.Process, 'on'>;
    exit?: (code: number) => void;
}

// A short pause lets the line reach the output before the process ends
const exitSoon = (code: number): void => {
    setTimeout(() => process.exit(code), 100);
};

/**
 * An error that nobody caught ends the process, as it always did, but now the log says why. The logger is asked for
 * at the moment of the failure, because the one of the application does not exist until it has started.
 */
export const installCrashHandlers = (logger: () => Pick<Logger, 'fatal'>, hooks: CrashHooks = {}): void => {
    const source = hooks.events ?? process;
    const exit = hooks.exit ?? exitSoon;
    source.on('uncaughtException', (error: Error) => {
        logger().fatal({ err: error }, 'An exception was not caught, exiting');
        exit(1);
    });
    source.on('unhandledRejection', (reason: unknown) => {
        logger().fatal({ err: reason instanceof Error ? reason : new Error(String(reason)) }, 'A promise was rejected and nobody handled it, exiting');
        exit(1);
    });
};
