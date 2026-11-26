import { describe, expect, it, vi } from 'vitest';
import { listenToMetricEvents, metric, type MetricEvents } from './metric-events';

describe('metric events', () => {
    it('does nothing while nobody listens', () => {
        expect(() => metric.login('local', 'success')).not.toThrow();
    });

    it('passes what happens to the listener, until it stops listening', () => {
        const login = vi.fn();
        const stop = listenToMetricEvents({ login } as unknown as MetricEvents);

        metric.login('local', 'success');
        stop();
        metric.login('local', 'failure');

        expect(login.mock.calls).toEqual([['local', 'success']]);
    });

    it('lets a listener that was replaced stop without taking the new one away', () => {
        const first = vi.fn();
        const second = vi.fn();
        const stopFirst = listenToMetricEvents({ profileCache: first } as unknown as MetricEvents);
        const stopSecond = listenToMetricEvents({ profileCache: second } as unknown as MetricEvents);

        stopFirst();
        metric.profileCache('hit');
        stopSecond();

        expect(first).not.toHaveBeenCalled();
        expect(second).toHaveBeenCalledWith('hit');
    });
});
