import type { LoggerService } from '@nestjs/common';

// What Nest says while it builds the application: one line for each module, controller and route, hundreds at every start
const FRAMEWORK_CONTEXTS = new Set(['InstanceLoader', 'RoutesResolver', 'RouterExplorer']);

type Level = 'log' | 'warn' | 'error' | 'debug' | 'verbose' | 'fatal';

/** Passes everything on to the logger of the application, but what Nest says while it builds the application goes to debug. */
export class QuietNestLogger implements LoggerService {
    constructor(private readonly inner: LoggerService) {}

    log(message: unknown, ...params: unknown[]): void {
        this.write('log', message, params);
    }

    warn(message: unknown, ...params: unknown[]): void {
        this.write('warn', message, params);
    }

    error(message: unknown, ...params: unknown[]): void {
        this.write('error', message, params);
    }

    debug(message: unknown, ...params: unknown[]): void {
        this.write('debug', message, params);
    }

    verbose(message: unknown, ...params: unknown[]): void {
        this.write('verbose', message, params);
    }

    fatal(message: unknown, ...params: unknown[]): void {
        this.write('fatal', message, params);
    }

    private write(level: Level, message: unknown, params: unknown[]): void {
        const context = params.at(-1);
        const target: Level = level === 'log' && typeof context === 'string' && FRAMEWORK_CONTEXTS.has(context) ? 'debug' : level;
        (this.inner[target] as (message: unknown, ...params: unknown[]) => void)?.call(this.inner, message, ...params);
    }
}
