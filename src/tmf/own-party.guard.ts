import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { DomainError, ForbiddenError } from '../common/domain-error';
import { AppConfigService } from '../config/app-config.service';
import { isResourceId } from './resource-id.pipe';
import type { UpstreamUser } from './upstream-headers';

/**
 * For a route whose path names a party as `:userId` or `:organizationId`: it may only be the party of the caller (the individual's or,
 * when acting for an organisation, the organisation's) unless the caller is an administrator. It runs after the
 * authentication, so there is always a user.
 */
@Injectable()
export class OwnPartyGuard implements CanActivate {
    constructor(private readonly config: AppConfigService) {}

    canActivate(context: ExecutionContext): boolean {
        const req = context.switchToHttp().getRequest<Request & { user?: UpstreamUser }>();
        const id = req.params['userId'] ?? req.params['organizationId'];
        if (typeof id !== 'string' || !isResourceId(id)) {
            throw new DomainError('Invalid id', 400);
        }
        const user = req.user;
        const admin = this.config.auth.roles.admin.toLowerCase();
        if (user !== undefined && ((user.roles ?? []).some((role) => role.name.toLowerCase() === admin) || id === user.partyId || id === user.userPartyId)) {
            return true;
        }
        throw new ForbiddenError('You are not allowed to access the resources of another party');
    }
}
