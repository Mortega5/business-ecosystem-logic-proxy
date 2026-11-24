import { describe, expect, it } from 'vitest';
import { SingleFlight } from './single-flight';

const later = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('SingleFlight', () => {
    it('does the work once for the ones that ask while it is running, and gives all the same answer', async () => {
        const flight = new SingleFlight<number>();
        let calls = 0;
        const work = async (): Promise<number> => {
            calls += 1;
            await later();
            return calls;
        };

        const answers = await Promise.all([flight.run('k', work), flight.run('k', work), flight.run('k', work)]);

        expect(answers).toEqual([1, 1, 1]);
        expect(calls).toBe(1);
    });

    it('does the work again for the one that asks once it has ended', async () => {
        const flight = new SingleFlight<number>();
        let calls = 0;
        const work = async (): Promise<number> => ++calls;

        await flight.run('k', work);
        await flight.run('k', work);

        expect(calls).toBe(2);
    });

    it('keeps the keys apart', async () => {
        const flight = new SingleFlight<string>();
        let calls = 0;
        const work = (name: string) => async (): Promise<string> => {
            calls += 1;
            await later();
            return name;
        };

        expect(await Promise.all([flight.run('a', work('a')), flight.run('b', work('b'))])).toEqual(['a', 'b']);
        expect(calls).toBe(2);
    });

    it('gives the failure to everybody who waited, and tries again on the next ask', async () => {
        const flight = new SingleFlight<string>();
        let calls = 0;
        const work = async (): Promise<string> => {
            calls += 1;
            await later();
            if (calls === 1) {
                throw new Error('down');
            }
            return 'up';
        };

        const first = await Promise.allSettled([flight.run('k', work), flight.run('k', work)]);
        expect(first.map((result) => result.status)).toEqual(['rejected', 'rejected']);
        expect(await flight.run('k', work)).toBe('up');
    });

    it('takes work that throws before it awaits as a rejection', async () => {
        const flight = new SingleFlight<string>();

        await expect(
            flight.run('k', () => {
                throw new Error('now');
            })
        ).rejects.toThrow('now');
        expect(await flight.run('k', async () => 'again')).toBe('again');
    });
});
