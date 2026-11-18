import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { NotFoundError } from '../common/domain-error';
import { FeatureFlagService } from './feature-flag.service';
import type { Feature } from './feature-flags';
import { REQUIRED_FEATURE } from './require-feature';

@Injectable()
export class FeatureGuard implements CanActivate {
    constructor(
        private readonly reflector: Reflector,
        private readonly flags: FeatureFlagService
    ) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const flag = this.reflector.getAllAndOverride<Feature | undefined>(REQUIRED_FEATURE, [context.getHandler(), context.getClass()]);
        if (flag === undefined || (await this.flags.isEnabled(flag))) {
            return true;
        }
        // NotFoundError and not NotFoundException: the latter is handed to the legacy application
        throw new NotFoundError('Not found');
    }
}
