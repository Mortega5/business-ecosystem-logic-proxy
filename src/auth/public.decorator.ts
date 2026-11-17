import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC = 'isPublic';

/** Everything is private unless a route (or controller) says otherwise. */
export const Public = (): ClassDecorator & MethodDecorator => SetMetadata(IS_PUBLIC, true);
