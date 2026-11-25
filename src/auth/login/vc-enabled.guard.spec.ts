import { describe, expect, it } from 'vitest';
import { NotFoundError } from '../../common/domain-error';
import type { AppConfigService } from '../../config/app-config.service';
import { VcEnabledGuard } from './vc-enabled.guard';

const guard = (enabled: boolean) => new VcEnabledGuard({ auth: { vc: { enabled } } } as unknown as AppConfigService);

describe('VcEnabledGuard', () => {
    it('lets the routes of the login with credentials in while it is on', () => {
        expect(guard(true).canActivate()).toBe(true);
    });

    it('answers 404 while it is off', () => {
        expect(() => guard(false).canActivate()).toThrow(NotFoundError);
    });
});
