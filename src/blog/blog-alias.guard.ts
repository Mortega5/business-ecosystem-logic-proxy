import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { NotFoundError } from '../common/domain-error';
import { AppConfigService } from '../config/app-config.service';

/** The name the blog had in v11, `/domeblog`. */
export const LEGACY_BLOG_PATH = '/domeblog';

/**
 * `/domeblog` serves the same as `/blog`, and exists only while the DOME extension is on: the portal of DOME still calls it. It is the
 * same route and not a redirect, because the preflight of a request from another origin cannot follow one.
 */
@Injectable()
export class BlogAliasGuard implements CanActivate {
    constructor(private readonly config: AppConfigService) {}

    canActivate(context: ExecutionContext): boolean {
        const path = context.switchToHttp().getRequest<Request>().path ?? '';
        const underAlias = path === LEGACY_BLOG_PATH || path.startsWith(`${LEGACY_BLOG_PATH}/`);
        if (!underAlias || this.config.dome.enabled) {
            return true;
        }
        // NotFoundError and not NotFoundException: the latter is handed to the legacy application
        throw new NotFoundError('Not found');
    }
}
