import { describe, expect, it } from 'vitest';
import { JsonBodyPipe, OptionalJsonBodyPipe } from './json-body.pipe';

describe('JsonBodyPipe', () => {
    const pipe = new JsonBodyPipe();

    it('hands over the text of a JSON object or array as it came', () => {
        expect(pipe.transform('{ "a" : 1 }')).toBe('{ "a" : 1 }');
        expect(pipe.transform('[1, 2]')).toBe('[1, 2]');
    });

    it.each([undefined, null, '', 'not json', '"text"', '7', 'true', 'null', {}])('refuses %j', (body) => {
        expect(() => pipe.transform(body)).toThrow('Invalid body');
    });
});

describe('OptionalJsonBodyPipe', () => {
    const pipe = new OptionalJsonBodyPipe();

    it('lets a request with no body through', () => {
        expect(pipe.transform(undefined)).toBeUndefined();
        expect(pipe.transform('')).toBeUndefined();
        expect(pipe.transform({})).toBeUndefined();
    });

    it('checks a body that is there as the required one does', () => {
        expect(pipe.transform('{"a":1}')).toBe('{"a":1}');
        expect(() => pipe.transform('not json')).toThrow('Invalid body');
        expect(() => pipe.transform('"text"')).toThrow('Invalid body');
        expect(() => pipe.transform({ a: 1 })).toThrow('Invalid body');
    });
});
