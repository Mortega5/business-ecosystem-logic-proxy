import { describe, expect, it } from 'vitest';
import { PortalConfigContributors } from './portal-config-contributors';

describe('PortalConfigContributors', () => {
    it('gathers what each extension adds, synchronously or not', async () => {
        const contributors = new PortalConfigContributors();
        contributors.register('one', () => ({ a: 1 }));
        contributors.register('two', () => Promise.resolve({ b: 2 }));
        expect(await contributors.collect()).toEqual({ a: 1, b: 2 });
    });

    it('has nothing when no extension adds anything', async () => {
        expect(await new PortalConfigContributors().collect()).toEqual({});
    });

    it('leaves out the extension that fails and keeps the others', async () => {
        const contributors = new PortalConfigContributors();
        contributors.register('broken', () => Promise.reject(new Error('down')));
        contributors.register('fine', () => ({ ok: true }));
        expect(await contributors.collect()).toEqual({ ok: true });
    });
});
