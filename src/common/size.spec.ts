import { describe, expect, it } from 'vitest';
import { parseSize } from './size';

describe('parseSize', () => {
    it.each([
        ['512b', 512],
        ['1kb', 1024],
        ['2mb', 2 * 1024 ** 2],
        ['50MB', 50 * 1024 ** 2],
        ['1.5kb', 1536],
        ['1gb', 1024 ** 3],
        [' 10 mb ', 10 * 1024 ** 2]
    ])('reads %s as %d bytes', (text, bytes) => {
        expect(parseSize(text)).toBe(bytes);
    });

    it.each(['', 'mb', '10', '10tb', '-1mb', '1.mb', 'ten mb', '1 mb mb'])('does not read %j', (text) => {
        expect(parseSize(text)).toBeUndefined();
    });
});
