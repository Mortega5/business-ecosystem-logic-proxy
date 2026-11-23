import { z } from 'zod';

/** A category as the catalog API gives it. */
export const category = z.looseObject({
    id: z.string().min(1),
    href: z.string().nullish(),
    name: z.string().nullish(),
    isRoot: z.boolean().nullish(),
    lifecycleStatus: z.string().nullish()
});

/** The category that a catalog lists. */
export const categoryRef = z.looseObject({
    id: z.string().min(1),
    href: z.string().nullish(),
    name: z.string().nullish()
});

export type Category = z.infer<typeof category>;
export type CategoryRef = z.infer<typeof categoryRef>;

/** What is sent to make a category. */
export interface CategoryDraft {
    name: string;
    description: string;
    isRoot: boolean;
    lifecycleStatus: string;
}
