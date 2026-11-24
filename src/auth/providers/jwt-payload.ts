/**
 * The claims of a JWT, read without checking its signature. Only for a token that the identity provider has just accepted (its user
 * info answered for it): what is read is what the provider itself put there.
 */
export const jwtPayload = (token: string): Record<string, unknown> | undefined => {
    const parts = token.split('.');
    if (parts.length !== 3) {
        return undefined;
    }
    try {
        const payload: unknown = JSON.parse(Buffer.from(parts[1] as string, 'base64url').toString('utf8'));
        return typeof payload === 'object' && payload !== null && !Array.isArray(payload) ? (payload as Record<string, unknown>) : undefined;
    } catch {
        return undefined;
    }
};
