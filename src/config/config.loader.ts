import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { ConfigSchema, type AppConfig } from './config.schema';

export type PlainObject = Record<string, unknown>;

export interface LoadOptions {
    defaultsPath: string;
    applicationPath?: string | undefined;
    env: NodeJS.ProcessEnv;
}

const ENV_PREFIX = 'BAE_';
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const isPlainObject = (value: unknown): value is PlainObject =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

export const deepMerge = (base: PlainObject, override: PlainObject): PlainObject => {
    const merged: PlainObject = { ...base };
    for (const [key, value] of Object.entries(override)) {
        if (FORBIDDEN_KEYS.has(key)) {
            continue;
        }
        const current = merged[key];
        merged[key] = isPlainObject(current) && isPlainObject(value) ? deepMerge(current, value) : value;
    }
    return merged;
};

const toCamelCase = (segment: string): string =>
    segment.toLowerCase().replace(/_([a-z0-9])/g, (_match, char: string) => char.toUpperCase());

const parseEnvValue = (raw: string): unknown => {
    if (raw.startsWith('[') || raw.startsWith('{')) {
        try {
            return JSON.parse(raw) as unknown;
        } catch {
            return raw;
        }
    }
    return raw;
};

/**
 * Maps BAE_<SECTION>__<KEY> variables to a nested object. `__` separates levels
 * and single underscores inside a level become camelCase, so
 * BAE_APP__SHUTDOWN_TIMEOUT_MS is app.shutdownTimeoutMs. Variables without `__`
 * are ignored, which keeps them apart from the legacy BAE_LP_* ones.
 */
export const envToObject = (env: NodeJS.ProcessEnv): PlainObject => {
    const result: PlainObject = {};
    for (const [name, raw] of Object.entries(env)) {
        if (raw === undefined || !name.startsWith(ENV_PREFIX) || !name.includes('__')) {
            continue;
        }
        const path = name.slice(ENV_PREFIX.length).split('__').map(toCamelCase);
        if (path.some((segment) => segment === '' || FORBIDDEN_KEYS.has(segment))) {
            continue;
        }
        let cursor = result;
        for (const segment of path.slice(0, -1)) {
            const next = cursor[segment];
            if (isPlainObject(next)) {
                cursor = next;
            } else {
                const created: PlainObject = {};
                cursor[segment] = created;
                cursor = created;
            }
        }
        cursor[path[path.length - 1] as string] = parseEnvValue(raw);
    }
    return result;
};

export const readYamlFile = (path: string): PlainObject => {
    let content: string;
    try {
        content = readFileSync(path, 'utf8');
    } catch (error) {
        throw new Error(`Cannot read configuration file ${path}: ${(error as Error).message}`);
    }
    const parsed: unknown = parse(content);
    if (parsed === null || parsed === undefined) {
        return {};
    }
    if (!isPlainObject(parsed)) {
        throw new Error(`Configuration file ${path} must contain a mapping at its top level`);
    }
    return parsed;
};

export const parseConfig = (raw: unknown): AppConfig => {
    const result = ConfigSchema.safeParse(raw);
    if (!result.success) {
        const details = result.error.issues.map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`).join('\n');
        throw new Error(`Invalid configuration:\n${details}`);
    }
    return result.data;
};

/** defaults < application file < environment variables. */
export const loadStaticConfig = (options: LoadOptions): AppConfig => {
    const defaults = readYamlFile(options.defaultsPath);
    const application = options.applicationPath === undefined ? {} : readYamlFile(options.applicationPath);
    return parseConfig(deepMerge(deepMerge(defaults, application), envToObject(options.env)));
};
