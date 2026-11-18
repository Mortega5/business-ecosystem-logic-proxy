import { Injectable, type PipeTransform } from '@nestjs/common';
import { DomainError } from '../common/domain-error';

// Letters, digits and the few marks of the ids TMForum uses (URNs such as urn:ngsi-ld:...:uuid); no dots alone
const RESOURCE_ID = /^(?!\.+$)[A-Za-z0-9:._-]{1,200}$/;

export const isResourceId = (value: string): boolean => RESOURCE_ID.test(value);

/** The id of a resource in a path: anything that is not an id is refused before it can be part of an upstream path. */
@Injectable()
export class ResourceIdPipe implements PipeTransform<string, string> {
    transform(value: string): string {
        if (!isResourceId(value)) {
            throw new DomainError('Invalid id', 400);
        }
        return value;
    }
}
