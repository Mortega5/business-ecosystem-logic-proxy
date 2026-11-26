import { describe, expect, it } from 'vitest';
import { upstreamErrorDetail } from './upstream-error-detail';

describe('upstreamErrorDetail', () => {
    it('takes the message of a JSON error body', () => {
        expect(upstreamErrorDetail('{"code":"X","message":"Offering 7 is not valid","extra":{"secret":1}}')).toBe('Offering 7 is not valid');
        expect(upstreamErrorDetail('{"error":"conflict"}')).toBe('conflict');
    });

    it('keeps nothing of a JSON body that has no message', () => {
        expect(upstreamErrorDetail('{"data":{"password":"x"}}')).toBeUndefined();
        expect(upstreamErrorDetail('[1,2]')).toBeUndefined();
    });

    it('takes the start of a text body, in one line', () => {
        expect(upstreamErrorDetail('bad\n  gateway')).toBe('bad gateway');
        const long = upstreamErrorDetail('x'.repeat(1000));
        expect(long?.length).toBe(301);
        expect(long?.endsWith('…')).toBe(true);
    });

    it('has nothing for an empty body', () => {
        expect(upstreamErrorDetail('  ')).toBeUndefined();
    });
});
