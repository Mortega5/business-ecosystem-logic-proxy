import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { ForbiddenError } from '../common/domain-error';
import { AppConfigService } from '../config/app-config.service';
import type { UpstreamUser } from './upstream-headers';

/** Only an administrator. It is a guard, so it answers before the body of the request is read. */
@Injectable()
export class AdministratorGuard implements CanActivate {
    constructor(private readonly config: AppConfigService) {}

    canActivate(context: ExecutionContext): boolean {
        const req = context.switchToHttp().getRequest<Request & { user?: UpstreamUser }>();
        const admin = this.config.auth.roles.admin.toLowerCase();
        if ((req.user?.roles ?? []).some((role) => role.name.toLowerCase() === admin)) {
            return true;
        }
        throw new ForbiddenError('You are not allowed to access this resource');
    }
}
