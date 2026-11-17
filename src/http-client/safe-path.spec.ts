import { describe, expect, it } from 'vitest';
import { assertSafePath } from './safe-path';

describe('assertSafePath', () => {
    it.each([
        '/documentSpecification',
        '/documentSpecification/',
        '/documentSpecification/urn:ngsi-ld:document:7a1c',
        '/media/v1.2/file.name.pdf',
        '/files/..hidden/.well-known',
        '/names/Jos%C3%A9%20Garc%C3%ADa',
        '/a%2Bb'
    ])('lets %s through unchanged', (path) => {
        expect(assertSafePath(path)).toBe(path);
    });

    it.each([
        ['dot segments', '/../productCatalogManagement/v4/productOffering'],
        ['dot segments inside', '/a/../../x'],
        ['a single dot segment', '/a/./b'],
        ['a trailing dot segment', '/a/..'],
        ['encoded dots', '/%2e%2e/%2e%2e/x'],
        ['upper case encoded dots', '/%2E%2E/x'],
        ['half encoded dots', '/.%2e/x'],
        ['half encoded dots, the other way', '/%2e./x'],
        ['encoded slash', '/a%2fb'],
        ['encoded slash, upper case', '/a%2Fb'],
        ['dots with an encoded slash', '/..%2fx'],
        ['encoded backslash', '/a%5cb'],
        ['plain backslash', '/a\\b'],
        ['backslash dot segments', '/..\\x'],
        ['double encoded dots', '/%252e%252e/x'],
        ['double encoded slash', '/a%252fb'],
        ['triple encoded dots', '/%25252e%25252e/x'],
        ['too many encodings', '/%2525252525'],
        ['a path parameter bypass', '/..;/x'],
        ['a path parameter', '/a;jsessionid=1/b'],
        ['a null byte', '/a%00b'],
        ['a raw control character', '/a\nb'],
        ['an encoded line break', '/a%0d%0ab'],
        ['a hidden query', '/a?b=c'],
        ['a hidden fragment', '/a#b'],
        ['an empty segment', '/a//b'],
        ['no leading slash', 'a/b'],
        ['malformed encoding', '/a%zz'],
        ['a lone percent', '/100%']
    ])('refuses %s', (_name, path) => {
        expect(() => assertSafePath(path)).toThrow('Invalid request path');
    });
});
