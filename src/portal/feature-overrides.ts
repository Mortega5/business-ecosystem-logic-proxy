import { FEATURE_NAMES, FEATURES } from '../features/feature-flags';
import type { Validated } from './validation';

const NAMES: string[] = FEATURE_NAMES.map((feature) => FEATURES[feature].dbName);

/** The feature flags that an administrator changes: at least one, each a boolean and one of the flags that exist. */
export const validateFeatureFlags = (body: Record<string, unknown>): Validated<Record<string, boolean>> => {
    const errors: string[] = [];
    const keys = Object.keys(body);
    if (keys.length === 0) {
        errors.push('At least one feature flag is required');
    }
    const changes: Record<string, boolean> = {};
    for (const key of keys) {
        const value = body[key];
        if (!NAMES.includes(key)) {
            errors.push(`${key} is not a configurable feature flag`);
        } else if (typeof value !== 'boolean') {
            errors.push(`${key} must be a boolean`);
        } else {
            changes[key] = value;
        }
    }
    return errors.length > 0 ? { errors } : { errors: [], value: changes };
};
