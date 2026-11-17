import { Injectable } from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';

export type LegacyMiddleware = (req: IncomingMessage, res: ServerResponse, next: (error?: unknown) => void) => unknown;

/**
 * Runs the legacy session, passport and authentication middlewares on a request that Nest routes, so it carries
 * `req.user` as it does in the legacy app. It disappears with them when authentication is migrated.
 */
@Injectable()
export class LegacyAuthBridge {
    private pipeline: LegacyMiddleware[] | undefined;

    attach(pipeline: LegacyMiddleware[]): void {
        this.pipeline = pipeline;
    }

    get attached(): boolean {
        return this.pipeline !== undefined;
    }

    /** Resolves when the whole chain called next; a middleware that answers the request itself leaves it unresolved. */
    run(req: IncomingMessage, res: ServerResponse): Promise<'continue' | 'answered'> {
        const pipeline = this.pipeline;
        if (pipeline === undefined) {
            return Promise.reject(new Error('The legacy authentication chain is not attached'));
        }
        return new Promise((resolve, reject) => {
            let index = 0;
            const step = (error?: unknown): void => {
                if (error !== undefined) {
                    reject(error instanceof Error ? error : new Error('A legacy middleware failed', { cause: error }));
                    return;
                }
                const middleware = pipeline[index];
                index += 1;
                if (middleware === undefined) {
                    resolve('continue');
                    return;
                }
                try {
                    const result = middleware(req, res, step);
                    if (result instanceof Promise) {
                        result.catch(reject);
                    }
                } catch (thrown) {
                    reject(thrown instanceof Error ? thrown : new Error('A legacy middleware failed', { cause: thrown }));
                }
            };
            res.once('close', () => resolve('answered'));
            step();
        });
    }
}
