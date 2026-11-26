const MAX_LENGTH = 300;
const MESSAGE_FIELDS = ['message', 'error', 'reason', 'detail', 'description', 'error_description'];

const shorten = (text: string): string => {
    const flat = text.replace(/\s+/g, ' ').trim();
    return flat.length > MAX_LENGTH ? `${flat.slice(0, MAX_LENGTH)}…` : flat;
};

/**
 * What an upstream said when it refused or failed a request, short enough for a log line: the message of a JSON error
 * body when it has one, otherwise the start of the text. Nothing else of the body is kept.
 */
export const upstreamErrorDetail = (body: string): string | undefined => {
    if (body.trim() === '') {
        return undefined;
    }
    try {
        const parsed: unknown = JSON.parse(body);
        if (typeof parsed === 'object' && parsed !== null) {
            const record = parsed as Record<string, unknown>;
            for (const field of MESSAGE_FIELDS) {
                const value = record[field];
                if (typeof value === 'string' && value !== '') {
                    return shorten(value);
                }
            }
            return undefined;
        }
    } catch {
        // Not JSON: the text itself is the detail
    }
    return shorten(body);
};
