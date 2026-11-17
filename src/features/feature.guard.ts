import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { NotFoundError } from '../common/domain-error';
import { FeatureFlagService } from './feature-flag.service';
import type { FeatureFlag } from './feature-flags';
import { REQUIRED_FEATURE } from './require-feature';

@Injectable()
export class FeatureGuard implements CanActivate {
    constructor(
        private readonly reflector: Reflector,
        private readonly flags: FeatureFlagService
    ) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const flag = this.reflector.getAllAndOverride<FeatureFlag | undefined>(REQUIRED_FEATURE, [context.getHandler(), context.getClass()]);
        if (flag === undefined || (await this.flags.isEnabled(flag))) {
            return true;
        }
        // NotFoundException would be handed to the legacy app; a disabled feature simply does not exist
        throw new NotFoundError('Not found');
    }
}
