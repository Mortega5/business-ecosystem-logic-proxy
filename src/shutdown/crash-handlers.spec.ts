import { describe, expect, it, vi } from 'vitest';
import { installCrashHandlers } from './crash-handlers';

const setup = () => {
    const handlers = new Map<string, (arg: unknown) => void>();
    const events = { on: vi.fn((event: string, handler: (arg: unknown) => void) => handlers.set(event, handler)) };
    const logger = { fatal: vi.fn() };
    const exit = vi.fn();
    installCrashHandlers(() => logger, { events: events as unknown as NodeJS.Process, exit });
    return { handlers, logger, exit };
};

describe('installCrashHandlers', () => {
    it('logs an exception that was not caught as fatal and exits with 1', () => {
        const { handlers, logger, exit } = setup();
        const error = new Error('boom');
        handlers.get('uncaughtException')?.(error);
        expect(logger.fatal).toHaveBeenCalledWith({ err: error }, 'An exception was not caught, exiting');
        expect(exit).toHaveBeenCalledWith(1);
    });

    it('logs a rejection nobody handled, also when it is not an error', () => {
        const { handlers, logger, exit } = setup();
        handlers.get('unhandledRejection')?.('plain text');
        expect(logger.fatal).toHaveBeenCalledWith(
            { err: expect.objectContaining({ message: 'plain text' }) as unknown },
            'A promise was rejected and nobody handled it, exiting'
        );
        expect(exit).toHaveBeenCalledWith(1);
    });
});
