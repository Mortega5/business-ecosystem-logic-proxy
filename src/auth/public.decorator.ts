import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC = 'isPublic';

/** Everything is private unless a route (or controller) says otherwise. */
export const Public = (): ClassDecorator & MethodDecorator => SetMetadata(IS_PUBLIC, true);

export const IS_OPTIONAL_AUTH = 'isOptionalAuth';

/** Open to anyone, and identified when they are logged in, for a route whose answer is the same for all but is asked for with the caller's identity. */
export const OptionalAuth = (): ClassDecorator & MethodDecorator => SetMetadata(IS_OPTIONAL_AUTH, true);
