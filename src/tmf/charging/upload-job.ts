import { DomainError } from '../../common/domain-error';
import { isRecord } from '../related-party';

const CONTENT_TYPE = /^[A-Za-z0-9][\w.+-]*\/[A-Za-z0-9][\w.+-]*$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

const hasControlCharacter = (value: string): boolean => {
    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        if (code < 0x20 || code === 0x7f) {
            return true;
        }
    }
    return false;
};

/** A name that cannot take a file out of the folder it is put in. */
const isSafeName = (name: string): boolean =>
    name.length > 0 && name.length <= 255 && !name.includes('/') && !name.includes('\\') && name !== '.' && name !== '..' && !hasControlCharacter(name);

/**
 * The upload of a file as the portal makes it, `{ content: { name, data }, contentType, isPublic }` with the file in base64, as
 * the text to send on: nothing but those fields goes to the backend, and the name, the type and the content are checked.
 */
export const checkedUploadJob = (body: string): string => {
    const upload: unknown = JSON.parse(body);
    const content = isRecord(upload) ? upload['content'] : undefined;
    if (!isRecord(upload) || !isRecord(content) || typeof content['name'] !== 'string' || typeof content['data'] !== 'string' || typeof upload['contentType'] !== 'string') {
        throw new DomainError('Invalid body', 400);
    }
    if (upload['isPublic'] !== undefined && typeof upload['isPublic'] !== 'boolean') {
        throw new DomainError('Invalid body', 400);
    }
    if (!isSafeName(content['name'])) {
        throw new DomainError('Invalid file name', 422);
    }
    if (!CONTENT_TYPE.test(upload['contentType'])) {
        throw new DomainError('Invalid content type', 422);
    }
    if (!BASE64.test(content['data'])) {
        throw new DomainError('Invalid file content', 422);
    }
    return JSON.stringify({
        content: { name: content['name'], data: content['data'] },
        contentType: upload['contentType'],
        ...(upload['isPublic'] === undefined ? {} : { isPublic: upload['isPublic'] })
    });
};
