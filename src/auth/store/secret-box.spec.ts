import { describe, expect, it } from 'vitest';
import { SecretBox } from './secret-box';

const SECRET = 's'.repeat(40);

describe('SecretBox', () => {
    it('opens what it sealed', () => {
        const box = new SecretBox(SECRET);

        expect(box.open(box.seal('refresh-token-123'))).toBe('refresh-token-123');
        expect(box.open(box.seal('ñ — 😀'))).toBe('ñ — 😀');
    });

    it('does not leave the text readable, and seals the same text differently each time', () => {
        const box = new SecretBox(SECRET);
        const first = box.seal('refresh-token-123');

        expect(first).not.toContain('refresh-token-123');
        expect(first).not.toContain(Buffer.from('refresh-token-123').toString('base64'));
        expect(box.seal('refresh-token-123')).not.toBe(first);
    });

    it('cannot open what was sealed with another secret', () => {
        const sealed = new SecretBox(SECRET).seal('text');

        expect(new SecretBox('x'.repeat(40)).open(sealed)).toBeUndefined();
    });

    it('cannot open what has been altered or is not sealed at all', () => {
        const box = new SecretBox(SECRET);
        const [version, iv, tag, encrypted] = box.seal('text').split('.') as [string, string, string, string];
        const flipped = Buffer.from(encrypted, 'base64');
        flipped[0] = (flipped[0] ?? 0) ^ 1;

        expect(box.open([version, iv, tag, flipped.toString('base64')].join('.'))).toBeUndefined();
        expect(box.open([version, iv, Buffer.alloc(16).toString('base64'), encrypted].join('.'))).toBeUndefined();
        expect(box.open('plain text')).toBeUndefined();
        expect(box.open('v2.a.b.c')).toBeUndefined();
        expect(box.open('')).toBeUndefined();
    });
});
