import { describe, expect, it } from 'vitest';
import { AimarketProvider } from './aimarket-provider';

const answering = (body: unknown): typeof fetch => (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
const provider = (body: unknown): AimarketProvider =>
    new AimarketProvider({ id: 'local', server: 'https://idm.example.org', clientId: 'bae', clientSecret: 's', timeoutMs: 1000, fetcher: answering(body) });

const user = { id: 'idm-ana', username: 'ana', displayName: 'Ana López', email: 'ana@example.org', roles: [{ id: 'r1', name: 'seller' }] };
const extra = (aimData: unknown): string => JSON.stringify({ aimData });

describe('AimarketProvider', () => {
    it('reads the user as a FIWARE manager does, and adds the first and last name it sends', async () => {
        const claims = await provider({ ...user, given_name: 'Ana', family_name: 'López' }).claimsOf('t');

        expect(claims).toMatchObject({ id: 'idm-ana', username: 'ana', roles: [{ id: 'r1', name: 'seller' }], givenName: 'Ana', familyName: 'López' });
    });

    it('takes the data of the AI Market over the names of the manager, and maps the gender', async () => {
        const claims = await provider({
            ...user,
            given_name: 'Ana',
            family_name: 'López',
            extra: extra({ user: { firstname: 'Anita', lastname: 'Pérez', gender: 'F', academicTitle: 'Dr.', language: 'es', pictureUrl: 'https://img.example.org/a.png' } })
        }).claimsOf('t');

        expect(claims).toMatchObject({ givenName: 'Anita', familyName: 'Pérez', gender: 'Female', academicTitle: 'Dr.', language: 'es', pictureUrl: 'https://img.example.org/a.png' });
    });

    it('maps the other genders', async () => {
        expect((await provider({ ...user, extra: extra({ user: { gender: 'M' } }) }).claimsOf('t')).gender).toBe('Male');
        expect((await provider({ ...user, extra: extra({ user: { gender: 'X' } }) }).claimsOf('t')).gender).toBe('Other');
    });

    it('goes on without the block when it is not what it should be, which v11 could not stand', async () => {
        for (const bad of ['not json', extra({}), extra('text'), '{"aimData":null}', 7, null]) {
            const claims = await provider({ ...user, given_name: 'Ana', extra: bad }).claimsOf('t');

            expect(claims).toMatchObject({ id: 'idm-ana', givenName: 'Ana' });
            expect(claims).not.toHaveProperty('gender');
        }
    });
});
