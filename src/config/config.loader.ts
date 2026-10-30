import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { ConfigSchema, type AppConfig } from './config.schema';
import { legacyEnvToObject, type LegacyVariable } from './legacy-env';
import { FORBIDDEN_KEYS, isPlainObject, setPath, type PlainObject } from './plain-object';

export type { PlainObject };

export interface LoadOptions {
    defaultsPath: string;
    applicationPath?: string | undefined;
    env: NodeJS.ProcessEnv;
    onLegacyVariable?: (variable: LegacyVariable) => void;
}

export const DEFAULT_APPLICATION_PATH = '/etc/bae/config/application.yaml';

const ENV_PREFIX = 'BAE_';
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
        setPath(result, path, parseEnvValue(raw));
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

/**
 * CONFIG_FILE wins and must exist; otherwise the default location is used only
 * when something is mounted there.
 */
export const resolveApplicationPath = (
    env: NodeJS.ProcessEnv,
    fileExists: (path: string) => boolean = existsSync
): string | undefined => {
    if (env.CONFIG_FILE !== undefined && env.CONFIG_FILE !== '') {
        return env.CONFIG_FILE;
    }
    return fileExists(DEFAULT_APPLICATION_PATH) ? DEFAULT_APPLICATION_PATH : undefined;
};

/** defaults < legacy variables < application file < environment variables. */
export const loadStaticConfig = (options: LoadOptions): AppConfig => {
    const defaults = readYamlFile(options.defaultsPath);
    const application = options.applicationPath === undefined ? {} : readYamlFile(options.applicationPath);
    const legacy = legacyEnvToObject(options.env);
    legacy.used.forEach((variable) => options.onLegacyVariable?.(variable));
    return parseConfig(deepMerge(deepMerge(deepMerge(defaults, legacy.values), application), envToObject(options.env)));
};

/** The configuration the application runs with: shipped defaults, optional application file and environment. */
export const loadAppConfig = (env: NodeJS.ProcessEnv, onLegacyVariable?: (variable: LegacyVariable) => void): AppConfig =>
    loadStaticConfig({
        defaultsPath: join(process.cwd(), 'config', 'default.yaml'),
        applicationPath: resolveApplicationPath(env),
        env,
        ...(onLegacyVariable === undefined ? {} : { onLegacyVariable })
    });
