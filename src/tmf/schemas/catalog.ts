import { z } from 'zod';
import { categoryRef, type CategoryRef } from './category';
import { relatedParty } from './related-party';

/** A catalog as the catalog API gives it; a catalog with no party, as the default one, has none listed. */
export const catalog = z.looseObject({
    id: z.string().min(1),
    name: z.string().nullish(),
    catalogType: z.string().nullish(),
    lifecycleStatus: z.string().nullish(),
    relatedParty: z.array(relatedParty).nullish(),
    category: z.array(categoryRef).nullish()
});

export type Catalog = z.infer<typeof catalog>;

/** What is sent to make a catalog. */
export interface CatalogDraft {
    name: string;
    description: string;
    catalogType: string;
    lifecycleStatus: string;
    category: CategoryRef[];
}

/** What is sent to change a catalog. */
export type CatalogChanges = Partial<Pick<CatalogDraft, 'catalogType' | 'category'>>;
