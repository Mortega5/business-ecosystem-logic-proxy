import { Injectable, type PipeTransform } from '@nestjs/common';
import { DomainError } from '../common/domain-error';

const checked = (body: string): string => {
    let parsed: unknown;
    try {
        parsed = JSON.parse(body);
    } catch {
        throw new DomainError('Invalid body', 400);
    }
    if (typeof parsed !== 'object' || parsed === null) {
        throw new DomainError('Invalid body', 400);
    }
    return body;
};

/** The body must be a JSON object or array; it is passed on as the text that came, not as what was parsed from it. */
@Injectable()
export class JsonBodyPipe implements PipeTransform<unknown, string> {
    transform(body: unknown): string {
        if (typeof body !== 'string') {
            throw new DomainError('Invalid body', 400);
        }
        return checked(body);
    }
}

/** Like `JsonBodyPipe`, for a route that may come with no body at all. */
@Injectable()
export class OptionalJsonBodyPipe implements PipeTransform<unknown, string | undefined> {
    transform(body: unknown): string | undefined {
        if (body === undefined || body === '' || (typeof body === 'object' && body !== null && Object.keys(body).length === 0)) {
            return undefined;
        }
        if (typeof body !== 'string') {
            throw new DomainError('Invalid body', 400);
        }
        return checked(body);
    }
}
