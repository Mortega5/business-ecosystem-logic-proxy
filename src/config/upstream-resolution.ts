import type { AppConfig } from './config.schema';

export interface ResolvedUpstream {
    baseUrl: string;
    timeoutMs: number;
}

interface Entry {
    host?: string | undefined;
    port?: number | undefined;
    scheme?: 'http' | 'https' | undefined;
    path?: string | undefined;
    timeoutMs?: number | undefined;
}

type Group = Entry & { apis?: Record<string, Entry> };

/** `tmforum.catalog` or `charging`: every value of the API wins over its group's, and the timeout over the global one. */
export const resolveUpstream = (upstreams: AppConfig['upstreams'], name: string): ResolvedUpstream => {
    const [groupName = '', apiName] = name.split('.');
    const group = (upstreams as unknown as Record<string, Group | number | undefined>)[groupName];
    if (group === undefined || typeof group === 'number') {
        throw new Error(`Unknown upstream "${name}"`);
    }
    const entry = apiName === undefined ? group : group.apis?.[apiName];
    if (entry === undefined) {
        throw new Error(`Unknown upstream "${name}"`);
    }
    const host = entry.host ?? group.host;
    if (host === undefined) {
        const where =
            apiName === undefined
                ? `upstreams.${groupName}.host`
                : `upstreams.${groupName}.host or upstreams.${groupName}.apis.${apiName}.host`;
        throw new Error(`Upstream "${name}" has no host: set ${where}`);
    }
    const port = entry.port ?? group.port;
    const scheme = entry.scheme ?? group.scheme ?? 'http';
    return {
        baseUrl: `${scheme}://${host}${port === undefined ? '' : `:${port}`}${entry.path ?? ''}`,
        timeoutMs: entry.timeoutMs ?? group.timeoutMs ?? upstreams.timeoutMs
    };
};
