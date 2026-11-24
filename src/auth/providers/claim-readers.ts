import type { ProfileOrganization, ProfileRole } from '../profile/user-profile';

type Json = Record<string, unknown>;

export const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);

export const rolesOf = (value: unknown): ProfileRole[] =>
    (Array.isArray(value) ? value : []).flatMap((role: unknown) => {
        const name = typeof role === 'object' && role !== null ? text((role as Json)['name']) : undefined;
        const id = typeof role === 'object' && role !== null ? text((role as Json)['id']) : undefined;
        return name === undefined ? [] : [{ id: id ?? name, name }];
    });

export const organizationsOf = (value: unknown): ProfileOrganization[] =>
    (Array.isArray(value) ? value : []).flatMap((entry: unknown) => {
        const org = typeof entry === 'object' && entry !== null ? (entry as Json) : {};
        const id = text(org['id']);
        const country = text(org['country']);
        return id === undefined ? [] : [{ id, name: text(org['name']) ?? id, roles: rolesOf(org['roles']), ...(country === undefined ? {} : { country }) }];
    });
