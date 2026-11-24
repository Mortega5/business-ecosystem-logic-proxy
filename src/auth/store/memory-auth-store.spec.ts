import { describe, expect, it } from 'vitest';
import { MemoryAuthStore } from './memory-auth-store';

const clock = (): { now: () => number; advance: (ms: number) => void } => {
    let time = 1_000;
    return { now: () => time, advance: (ms) => (time += ms) };
};

describe('MemoryAuthStore', () => {
    it('gives back what was stored, and nothing for a key it does not have', async () => {
        const store = new MemoryAuthStore(10);
        await store.set('profile:a', { id: 'u1', roles: [{ name: 'seller' }] }, 1000);

        expect(await store.get('profile:a')).toEqual({ id: 'u1', roles: [{ name: 'seller' }] });
        expect(await store.get('profile:b')).toBeUndefined();
    });

    it('forgets a value when its time is over, however much it is read', async () => {
        const time = clock();
        const store = new MemoryAuthStore(10, time.now);
        await store.set('k', 'v', 1000);

        time.advance(999);
        expect(await store.get('k')).toBe('v');
        time.advance(1);
        expect(await store.get('k')).toBeUndefined();
    });

    it('does not share objects with the caller, as a store that serialises would not', async () => {
        const store = new MemoryAuthStore(10);
        const profile = { id: 'u1', roles: ['a'] };
        await store.set('k', profile, 1000);
        profile.roles.push('b');

        const read = (await store.get('k')) as typeof profile;
        read.roles.push('c');

        expect(await store.get('k')).toEqual({ id: 'u1', roles: ['a'] });
    });

    it('drops the oldest entry when it is full, and what has expired before that', async () => {
        const time = clock();
        const store = new MemoryAuthStore(2, time.now);
        await store.set('short', 1, 10);
        await store.set('old', 2, 1000);
        time.advance(20);
        await store.set('new', 3, 1000);

        // `short` had expired, so nothing else had to go
        expect(await store.get('old')).toBe(2);
        expect(await store.get('new')).toBe(3);

        await store.set('newest', 4, 1000);
        expect(await store.get('old')).toBeUndefined();
        expect(await store.get('new')).toBe(3);
        expect(await store.get('newest')).toBe(4);
    });

    it('moves a key that is written again to the end of the order', async () => {
        const store = new MemoryAuthStore(2);
        await store.set('a', 1, 1000);
        await store.set('b', 2, 1000);
        await store.set('a', 3, 1000);
        await store.set('c', 4, 1000);

        expect(await store.get('b')).toBeUndefined();
        expect(await store.get('a')).toBe(3);
    });

    it('deletes a key, and does not mind one that is not there', async () => {
        const store = new MemoryAuthStore(10);
        await store.set('k', 'v', 1000);
        await store.delete('k');
        await store.delete('nothing');

        expect(await store.get('k')).toBeUndefined();
    });
});
