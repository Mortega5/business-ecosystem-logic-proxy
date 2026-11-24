import type { IdentityClaims } from '../profile/user-profile';
import { FiwareProvider } from './fiware-provider';

type Json = Record<string, unknown>;

const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);

// What the AI Market sends as `extra` is a JSON text; one that does not read is as if it had not come
const aimDataOf = (extra: unknown): Json | undefined => {
    try {
        const parsed: unknown = typeof extra === 'string' ? JSON.parse(extra) : extra;
        const user = typeof parsed === 'object' && parsed !== null ? ((parsed as Json)['aimData'] as Json | undefined)?.['user'] : undefined;
        return typeof user === 'object' && user !== null ? (user as Json) : undefined;
    } catch {
        return undefined;
    }
};

const genderOf = (code: string): string => (code === 'M' ? 'Male' : code === 'F' ? 'Female' : 'Other');

/**
 * The identity manager of the AI Market: a FIWARE one that also sends the first and last name, and a block of data of the person
 * (`extra.aimData.user`) that overrides what the manager says of their name.
 */
export class AimarketProvider extends FiwareProvider {
    protected override claimsFrom(json: Json): IdentityClaims {
        const claims = super.claimsFrom(json);
        const aim = aimDataOf(json['extra']);
        const gender = text(aim?.['gender']);

        const given = text(aim?.['firstname']) ?? text(json['given_name']);
        const family = text(aim?.['lastname']) ?? text(json['family_name']);
        const academicTitle = text(aim?.['academicTitle']);
        const language = text(aim?.['language']);
        const pictureUrl = text(aim?.['pictureUrl']);

        return {
            ...claims,
            ...(given === undefined ? {} : { givenName: given }),
            ...(family === undefined ? {} : { familyName: family }),
            ...(gender === undefined ? {} : { gender: genderOf(gender) }),
            ...(academicTitle === undefined ? {} : { academicTitle }),
            ...(language === undefined ? {} : { language }),
            ...(pictureUrl === undefined ? {} : { pictureUrl })
        };
    }
}
