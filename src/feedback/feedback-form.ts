import { z } from 'zod';

/** What the feedback form of the portal sends: a rating, what the feedback is about and, if the visitor wrote one, a comment. */
export const feedbackForm = (limits: { nameLength: number; noteLength: number }) =>
    z.object({
        rating: z.number().int().min(1).max(5),
        type: z.string().trim().max(limits.nameLength).optional(),
        description: z.string().max(limits.noteLength).optional()
    });

export type FeedbackForm = z.infer<ReturnType<typeof feedbackForm>>;
