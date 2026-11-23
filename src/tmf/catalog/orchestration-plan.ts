import { isRecord } from '../related-party';

/*
 * A Blueprint step wires itself to a sibling with a substitution placeholder, because the consumer chooses the release identity per
 * deployment and a sibling's address is not known when the Blueprint is written. Only `<<steps.` is reserved; any other string passes
 * as it is, which is why chart values with Go templates, shell expansions or heredocs are never touched.
 *
 *   placeholder := '<<' WS? 'steps.' stepId ('.' segment)+ WS? '>>'
 */
const PLACEHOLDER = /<<\s*steps\.([a-z0-9-]+)((?:\.[A-Za-z0-9_-]+)+)\s*>>/g;
const RESERVED_PREFIX = /<<\s*steps\./;
const RESOLUTION_ROOTS = ['deploymentName', 'namespace', 'service'];

interface Reference {
    raw: string;
    /** Nothing when the text starts the reserved prefix and is not a reference that parses. */
    stepId?: string;
    field?: string;
}

/** Every placeholder in the strings of a value, and every object key that has one: a resolved key could not be matched in the merge of the layers. */
const placeholdersOf = (root: unknown): { references: Reference[]; keys: string[] } => {
    const references: Reference[] = [];
    const keys: string[] = [];
    const walk = (value: unknown, at: string): void => {
        if (Array.isArray(value)) {
            value.forEach((item, index) => walk(item, `${at}[${index}]`));
        } else if (isRecord(value)) {
            for (const [key, inner] of Object.entries(value)) {
                const here = at === '' ? key : `${at}.${key}`;
                if (RESERVED_PREFIX.test(key)) {
                    keys.push(here);
                }
                walk(inner, here);
            }
        } else if (typeof value === 'string' && RESERVED_PREFIX.test(value)) {
            const found = [...value.matchAll(PLACEHOLDER)];
            // A '<<steps.' that does not parse is a typo: it would reach Helm and fail hours later as broken traffic
            if (found.length === 0) {
                references.push({ raw: value });
            }
            for (const match of found) {
                references.push({ raw: match[0], stepId: match[1] ?? '', field: (match[2] ?? '').slice(1) });
            }
        }
    };
    walk(root, '');
    return { references, keys };
};

/**
 * What is wrong with the plan of a Blueprint, or nothing when it is fine, so that the orchestrator does not reject it half way
 * through its graph. A reference may only name a step that this one depends on directly, and must be one of the known paths; the
 * ids of the steps are unique; and placeholders are values, never keys. The check that no lock of the Blueprint collides with the
 * enforced values of a component is not here: it has to read every component down to its support package.
 */
export const orchestrationPlanProblem = (plan: unknown): string | undefined => {
    if (!plan) {
        return undefined;
    }
    const steps = isRecord(plan) ? plan['steps'] : undefined;
    if (!Array.isArray(steps)) {
        return 'orchestrationPlan must contain a steps array';
    }
    const ids = new Set<unknown>();
    for (const step of steps as unknown[]) {
        if (!isRecord(step) || !step['id']) {
            return 'Every orchestrationPlan step must have an id';
        }
        if (ids.has(step['id'])) {
            return `Duplicated orchestrationPlan step id: ${typeof step['id'] === 'string' ? step['id'] : JSON.stringify(step['id'])}`;
        }
        ids.add(step['id']);
    }
    for (const step of steps as Record<string, unknown>[]) {
        const id = typeof step['id'] === 'string' ? step['id'] : JSON.stringify(step['id']);
        const dependsOn = new Set<unknown>(Array.isArray(step['dependsOn']) ? step['dependsOn'] : []);
        const { references, keys } = placeholdersOf(step['enforcedCharacteristic']);
        if (keys.length > 0) {
            return `Step ${id}: a placeholder cannot be used in an object key (${keys[0] ?? ''})`;
        }
        for (const reference of references) {
            if (reference.stepId === undefined) {
                return `Step ${id}: '<<steps.' is reserved and this is not a valid reference: ${reference.raw}`;
            }
            const root = (reference.field ?? '').split('.')[0] ?? '';
            if (!RESOLUTION_ROOTS.includes(root)) {
                return `Step ${id}: unknown reference ${reference.raw} - only ${RESOLUTION_ROOTS.join(', ')} can be referenced`;
            }
            if (!ids.has(reference.stepId)) {
                return `Step ${id}: ${reference.raw} refers to a step that is not in this plan`;
            }
            if (reference.stepId === id && root === 'service') {
                return `Step ${id}: a step cannot reference its own service, which does not exist until it has deployed`;
            }
            // A path through other steps changes no order, so asking for the direct edge costs nothing and keeps the dependency visible
            if (reference.stepId !== id && !dependsOn.has(reference.stepId)) {
                return `Step ${id}: ${reference.raw} refers to a step that is not in its dependsOn - add the edge, with waitForHealthy false if you do not want to wait for it`;
            }
        }
    }
    return undefined;
};
