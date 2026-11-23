import { z } from 'zod';

/** A resource specification as the resource and software APIs give it. */
export const resourceSpecification = z.looseObject({
    id: z.string().min(1),
    name: z.string().nullish(),
    '@type': z.string().nullish()
});

export type ResourceSpecification = z.infer<typeof resourceSpecification>;
