import type { ExecutionContext } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { NotFoundError } from '../common/domain-error';
import type { AppConfigService } from '../config/app-config.service';
import { BlogAliasGuard } from './blog-alias.guard';

const run = (path: string, domeEnabled: boolean): boolean =>
    new BlogAliasGuard({ dome: { enabled: domeEnabled } } as AppConfigService).canActivate({
        switchToHttp: () => ({ getRequest: () => ({ path }) })
    } as unknown as ExecutionContext);

describe('BlogAliasGuard: /domeblog is another name for /blog while the DOME extension is on', () => {
    it('lets /blog in whether the extension is on or not', () => {
        expect(run('/blog', false)).toBe(true);
        expect(run('/blog/abc', false)).toBe(true);
        expect(run('/blog', true)).toBe(true);
    });

    it('lets /domeblog in while the extension is on, the same as /blog', () => {
        expect(run('/domeblog', true)).toBe(true);
        expect(run('/domeblog/abc', true)).toBe(true);
    });

    it('answers 404 to /domeblog while the extension is off, and does not hand it to the legacy application', () => {
        expect(() => run('/domeblog', false)).toThrow(NotFoundError);
        expect(() => run('/domeblog/abc', false)).toThrow(NotFoundError);
    });
});
