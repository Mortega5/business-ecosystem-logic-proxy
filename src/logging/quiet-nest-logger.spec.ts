import { describe, expect, it, vi } from 'vitest';
import { QuietNestLogger } from './quiet-nest-logger';

const setup = () => {
    const inner = { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    return { inner, logger: new QuietNestLogger(inner) };
};

describe('QuietNestLogger', () => {
    it('sends to debug what Nest says while it builds the application', () => {
        const { inner, logger } = setup();
        logger.log('Mapped {/version, GET} route', 'RouterExplorer');
        logger.log('AppModule dependencies initialized', 'InstanceLoader');
        logger.log('VersionController {/version}:', 'RoutesResolver');

        expect(inner.debug).toHaveBeenCalledTimes(3);
        expect(inner.log).not.toHaveBeenCalled();
    });

    it('keeps the level of everything else, and of the warnings and errors of the framework', () => {
        const { inner, logger } = setup();
        logger.log('Nest application successfully started', 'NestApplication');
        logger.log({ a: 1 }, 'Orders');
        logger.warn('careful', 'RouterExplorer');
        logger.error({ err: new Error('x') }, 'boom', 'ErrorFilter');

        expect(inner.log).toHaveBeenCalledTimes(2);
        expect(inner.warn).toHaveBeenCalledWith('careful', 'RouterExplorer');
        expect(inner.error).toHaveBeenCalledWith({ err: expect.any(Error) }, 'boom', 'ErrorFilter');
    });
});
