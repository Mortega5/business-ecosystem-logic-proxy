import { SetMetadata } from '@nestjs/common';
import type { FeatureFlag } from './feature-flags';

export const REQUIRED_FEATURE = 'requiredFeature';

/** The route (or every route of the controller) only exists while the flag is on. */
export const RequireFeature = (flag: FeatureFlag): ClassDecorator & MethodDecorator => SetMetadata(REQUIRED_FEATURE, flag);
