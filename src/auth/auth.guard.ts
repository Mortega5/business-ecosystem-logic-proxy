import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { IncomingMessage } from 'node:http';
import { PinoLogger } from 'nestjs-pino';
import { actorLogFields } from './actor-log-fields';
import { UnauthorizedError } from '../common/domain-error';
import { IS_OPTIONAL_AUTH, IS_PUBLIC } from './public.decorator';
import { RequestAuthenticator, type AuthenticatedUser } from './request-authenticator';

/** Resolves who is calling, then lets in only logged-in users unless the route is marked @Public() or @OptionalAuth(). */
@Injectable()
export class AuthGuard implements CanActivate {
    constructor(
        private readonly reflector: Reflector,
        private readonly authenticator: RequestAuthenticator,
        private readonly logger: PinoLogger
    ) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const req = context.switchToHttp().getRequest<IncomingMessage & { user?: AuthenticatedUser }>();
        const targets = [context.getHandler(), context.getClass()];

        // A public route is not identified at all, so probes and static answers never open a session
        if (this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC, targets) === true) {
            return true;
        }

        const user = await this.authenticator.authenticate(req);
        if (user !== undefined) {
            req.user = user;
            this.logger.assign(actorLogFields(user));
            return true;
        }
        if (this.reflector.getAllAndOverride<boolean | undefined>(IS_OPTIONAL_AUTH, targets) === true) {
            return true;
        }
        throw new UnauthorizedError('You need to be authenticated to perform this request');
    }
}
