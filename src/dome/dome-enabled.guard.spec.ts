import { describe, expect, it } from 'vitest';
import { NotFoundError } from '../common/domain-error';
import type { AppConfigService } from '../config/app-config.service';
import { DomeEnabledGuard } from './dome-enabled.guard';

const guard = (enabled: boolean) => new DomeEnabledGuard({ dome: { enabled } } as AppConfigService);

describe('DomeEnabledGuard', () => {
    it('lets the routes of the extension in while it is on', () => {
        expect(guard(true).canActivate()).toBe(true);
    });

    it('answers 404, and does not hand the route to the legacy application, while it is off', () => {
        expect(() => guard(false).canActivate()).toThrow(NotFoundError);
    });
});
