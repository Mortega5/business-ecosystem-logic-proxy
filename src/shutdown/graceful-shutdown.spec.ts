import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installGracefulShutdown, type ShutdownTarget } from './graceful-shutdown';

const setup = (overrides: Partial<{ close: () => Promise<void>; timeoutMs: number }> = {}) => {
    const calls: string[] = [];
    const logger = { info: vi.fn(), fatal: vi.fn() };
    const legacy = {
        stopBackgroundLoaders: vi.fn(() => calls.push('legacy.stopBackgroundLoaders')),
        close: vi.fn(async () => {
            calls.push('legacy.close');
        })
    };
    const app = {
        close: vi.fn(
            overrides.close ??
                (async (signal?: string) => {
                    calls.push(`app.close(${signal})`);
                })
        )
    };
    const signals = new EventEmitter();
    const exit = vi.fn((code: number) => {
        calls.push(`exit(${code})`);
    });
    const target: ShutdownTarget = { app, legacy, logger, timeoutMs: overrides.timeoutMs ?? 5000 };
    installGracefulShutdown(target, { signals: signals as unknown as NodeJS.Process, exit });
    return { calls, logger, legacy, app, signals, exit };
};

const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

describe('installGracefulShutdown', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it.each(['SIGTERM', 'SIGINT'])('on %s stops the legacy loaders, closes the app, closes the legacy and exits 0, in that order', async (signal) => {
        const { calls, logger, signals } = setup();

        signals.emit(signal);
        await settled();

        expect(calls).toEqual(['legacy.stopBackgroundLoaders', `app.close(${signal})`, 'legacy.close', 'exit(0)']);
        expect(logger.info).toHaveBeenCalledWith({ signal, timeoutMs: 5000 }, 'Shutting down');
        expect(logger.info).toHaveBeenCalledWith('Shutdown complete');
    });

    it('ignores further signals while it is already shutting down', async () => {
        const { app, signals, exit } = setup();

        signals.emit('SIGTERM');
        signals.emit('SIGINT');
        signals.emit('SIGTERM');
        await settled();

        expect(app.close).toHaveBeenCalledTimes(1);
        expect(exit).toHaveBeenCalledTimes(1);
    });

    it('exits with code 1 and a fatal entry when the shutdown does not finish in time', async () => {
        vi.useFakeTimers();
        const { logger, legacy, signals, exit } = setup({ close: () => new Promise(() => undefined), timeoutMs: 1000 });

        signals.emit('SIGTERM');
        await vi.advanceTimersByTimeAsync(999);
        expect(exit).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(2);

        expect(exit).toHaveBeenCalledWith(1);
        expect(logger.fatal).toHaveBeenCalledWith({ timeoutMs: 1000 }, 'Shutdown did not finish in time, exiting');
        expect(legacy.close).not.toHaveBeenCalled();
    });

    it('exits with code 1 and logs the error when closing fails', async () => {
        const failure = new Error('close failed');
        const { logger, signals, exit } = setup({ close: () => Promise.reject(failure) });

        signals.emit('SIGTERM');
        await settled();

        expect(exit).toHaveBeenCalledWith(1);
        expect(exit).toHaveBeenCalledTimes(1);
        expect(logger.fatal).toHaveBeenCalledWith({ err: failure }, 'Shutdown failed');
    });
});
