import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionData } from 'express-session';
import { MemoryAuthStore } from '../store/memory-auth-store';
import { AuthSessionStore } from './session-store';

const call = <T>(run: (done: (err: unknown, value?: T) => void) => void): Promise<T | undefined> =>
    new Promise((resolve, reject) => run((err, value) => (err ? reject(err as Error) : resolve(value))));

const sessionOf = (extra: Record<string, unknown> = {}, expires?: Date) =>
    ({ cookie: { originalMaxAge: null, expires }, ...extra }) as unknown as SessionData;

describe('AuthSessionStore', () => {
    let clock: number;
    let backing: MemoryAuthStore;
    let sessions: AuthSessionStore;

    beforeEach(() => {
        clock = 1_000_000;
        backing = new MemoryAuthStore(10, () => clock);
        sessions = new AuthSessionStore(backing, 60_000, () => clock);
    });

    it('stores and returns a session, and null when there is none', async () => {
        await call<void>((done) => sessions.set('a', sessionOf({ token: 't' }), done));
        expect(await call((done) => sessions.get('a', done))).toMatchObject({ token: 't' });
        expect(await call((done) => sessions.get('b', done))).toBeNull();
    });

    it('keeps the session under a prefix of its own', async () => {
        await call<void>((done) => sessions.set('a', sessionOf(), done));
        expect(await backing.get('session:a')).toBeDefined();
        expect(await backing.get('a')).toBeUndefined();
    });

    it('destroys a session', async () => {
        await call<void>((done) => sessions.set('a', sessionOf(), done));
        await call<void>((done) => sessions.destroy('a', done));
        expect(await call((done) => sessions.get('a', done))).toBeNull();
    });

    it('lasts as long as the cookie, or the default when the cookie has no end', async () => {
        await call<void>((done) => sessions.set('a', sessionOf({}, new Date(clock + 5_000)), done));
        await call<void>((done) => sessions.set('b', sessionOf(), done));
        clock += 6_000;
        expect(await call((done) => sessions.get('a', done))).toBeNull();
        expect(await call((done) => sessions.get('b', done))).not.toBeNull();
        clock += 60_000;
        expect(await call((done) => sessions.get('b', done))).toBeNull();
    });

    it('renews the time of a session that is touched', async () => {
        await call<void>((done) => sessions.set('a', sessionOf({}, new Date(clock + 5_000)), done));
        clock += 4_000;
        await call<void>((done) => sessions.touch('a', sessionOf({}, new Date(clock + 5_000)), done));
        clock += 4_000;
        expect(await call((done) => sessions.get('a', done))).not.toBeNull();
    });

    it('passes on the failure of the store', async () => {
        const failing = {
            get: vi.fn().mockRejectedValue(new Error('down')),
            set: vi.fn().mockRejectedValue(new Error('down')),
            delete: vi.fn().mockRejectedValue(new Error('down'))
        };
        const broken = new AuthSessionStore(failing, 1000);
        await expect(call((done) => broken.get('a', done))).rejects.toThrow('down');
        await expect(call<void>((done) => broken.set('a', sessionOf(), done))).rejects.toThrow('down');
        await expect(call<void>((done) => broken.destroy('a', done))).rejects.toThrow('down');
    });
});
