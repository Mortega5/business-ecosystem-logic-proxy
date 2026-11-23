import type { z } from 'zod';
import { DomainError } from '../../common/domain-error';

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

/** What a client sent, as the type that the code reads: anything that is not that is a 400 with the message given, and what is not in the schema is not kept. */
export const parseRequest = <S extends z.ZodType>(schema: S, value: unknown, refusal: string): z.infer<S> => {
    const result = schema.safeParse(value);
    if (!result.success) {
        throw new DomainError(refusal, 400);
    }
    return result.data;
};
