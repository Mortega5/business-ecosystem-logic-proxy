import { DomainError } from '../common/domain-error';

const MAX_DECODINGS = 3;
const ENCODED_SEPARATOR = /%(2f|5c)/i;

const hasControlCharacter = (value: string): boolean => {
    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        if (code < 0x20 || code === 0x7f) {
            return true;
        }
    }
    return false;
};

const reject = (): never => {
    throw new DomainError('Invalid request path', 400);
};

const decode = (value: string): string => {
    try {
        return decodeURIComponent(value);
    } catch {
        return reject();
    }
};

const checkSegments = (value: string): void => {
    if (hasControlCharacter(value) || value.includes('\\') || value.includes(';')) {
        reject();
    }
    if (value.split('/').some((segment) => segment === '.' || segment === '..')) {
        reject();
    }
};

/**
 * A path that can only stay inside the API it is appended to. Whatever could make the upstream, or the URL parser
 * here, move to another part of the server is refused instead of cleaned: dot segments, however many times encoded,
 * encoded or plain separators that were not meant, `;` (which servers read as a path parameter, as in `..;/`),
 * control characters and a query or fragment hidden in the path.
 */
export const assertSafePath = (path: string): string => {
    if (!path.startsWith('/') || path.includes('?') || path.includes('#') || path.includes('//')) {
        reject();
    }
    let current = path;
    for (let decodings = 0; ; decodings += 1) {
        checkSegments(current);
        if (ENCODED_SEPARATOR.test(current)) {
            reject();
        }
        const decoded = decode(current);
        if (decoded === current) {
            return path;
        }
        if (decodings === MAX_DECODINGS) {
            reject();
        }
        current = decoded;
    }
};
