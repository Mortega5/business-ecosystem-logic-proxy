import { z } from 'zod';

/** A party related to an entity, which the code reads by its id and by the role that makes it the owner, the buyer or the operator. */
export const relatedParty = z.looseObject({
    id: z.string().min(1),
    role: z.string().min(1)
});

export type RelatedParty = z.infer<typeof relatedParty>;
