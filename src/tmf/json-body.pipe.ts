import { Injectable, type PipeTransform } from '@nestjs/common';
import { DomainError } from '../common/domain-error';

/** The body must be a JSON object or array; it is passed on as the text that came, not as what was parsed from it. */
@Injectable()
export class JsonBodyPipe implements PipeTransform<unknown, string> {
    transform(body: unknown): string {
        if (typeof body !== 'string') {
            throw new DomainError('Invalid body', 400);
        }
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
    }
}
