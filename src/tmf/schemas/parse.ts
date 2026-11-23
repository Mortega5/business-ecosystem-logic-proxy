import type { z } from 'zod';

/**
 * What an API of the TMForum answered, as the type that the code reads: it fails, naming what is wrong, when it is not that. The JSON
 * is another service's, so a type that nobody checks would only say what is hoped.
 */
export const parseEntity = <S extends z.ZodType>(schema: S, value: unknown, what: string): z.infer<S> => {
    const result = schema.safeParse(value);
    if (!result.success) {
        const problems = result.error.issues.map((issue) => `${issue.path.join('.') || '(the value)'}: ${issue.message}`).join('; ');
        throw new Error(`${what} is not as expected: ${problems}`);
    }
    return result.data;
};
