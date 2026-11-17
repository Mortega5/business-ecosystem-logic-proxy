import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { UnauthorizedError } from '../common/domain-error';
import { LegacyAuthBridge } from '../legacy/legacy-auth.bridge';
import { IS_PUBLIC } from './public.decorator';

/** Resolves who is calling, then lets in only logged-in users unless the route is marked @Public(). */
@Injectable()
export class AuthGuard implements CanActivate {
    constructor(
        private readonly reflector: Reflector,
        private readonly bridge: LegacyAuthBridge
    ) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const http = context.switchToHttp();
        const req = http.getRequest<IncomingMessage & { user?: unknown }>();
        const res = http.getResponse<ServerResponse>();
        const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC, [
            context.getHandler(),
            context.getClass()
        ]);

        // A public route is not identified at all, so probes and static answers never open a session
        if (isPublic === true) {
            return true;
        }

        // Closed when the chain is not there: a route must never end up unauthenticated because a piece is missing
        if (!this.bridge.attached) {
            throw new UnauthorizedError('You need to be authenticated to perform this request');
        }

        if ((await this.bridge.run(req, res)) === 'answered') {
            return false;
        }
        if (req.user !== undefined) {
            return true;
        }
        throw new UnauthorizedError('You need to be authenticated to perform this request');
    }
}
