/** What the rest of the proxy tells about what happens, so that the metrics are kept in one place. */
export interface MetricEvents {
    /** A call to a third party: `upstream` is its name, `outcome` the class of its status (`2xx`...), `timeout` or `network`. */
    upstreamCall(upstream: string, method: string, outcome: string, seconds: number): void;
    login(provider: string, result: 'success' | 'failure'): void;
    profileCache(result: 'hit' | 'miss'): void;
    statsRefresh(result: 'success' | 'failure'): void;
    mongoUp(up: boolean): void;
}

let listener: MetricEvents | undefined;

/** Makes `events` hear what happens, until the function that is returned is called. */
export const listenToMetricEvents = (events: MetricEvents): (() => void) => {
    listener = events;
    return () => {
        if (listener === events) {
            listener = undefined;
        }
    };
};

/** Tells what happens. It does nothing while nobody listens, so a module never needs the metrics to be there. */
export const metric: MetricEvents = {
    upstreamCall: (upstream, method, outcome, seconds) => listener?.upstreamCall(upstream, method, outcome, seconds),
    login: (provider, result) => listener?.login(provider, result),
    profileCache: (result) => listener?.profileCache(result),
    statsRefresh: (result) => listener?.statsRefresh(result),
    mongoUp: (up) => listener?.mongoUp(up)
};
