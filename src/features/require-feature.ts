import { SetMetadata } from '@nestjs/common';
import type { Feature } from './feature-flags';

export const REQUIRED_FEATURE = 'requiredFeature';

/** The route (or every route of the controller) only exists while the feature is on. */
export const RequireFeature = (feature: Feature): ClassDecorator & MethodDecorator => SetMetadata(REQUIRED_FEATURE, feature);
