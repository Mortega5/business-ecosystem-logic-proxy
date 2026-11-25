import { describe, expect, it } from 'vitest';
import { IdpError } from './idp-http';
import { claimsFromCredential, type CredentialPolicy } from './vc-credential';

const policy: CredentialPolicy = {
    roles: { admin: 'admin', customer: 'customer', seller: 'seller', orgAdmin: 'manager', certifier: 'certifier' },
    operators: []
};

const employee = (
    power: object[],
    mandator: object = {},
    mandatee: object = {},
    issuer: unknown = { id: 'did:elsi:ISSUER' }
) => ({
    verifiableCredential: {
        type: ['VerifiableCredential', 'LEARCredentialEmployee'],
        issuer,
        credentialSubject: {
            mandate: {
                mandator: { organizationIdentifier: 'VATES-1', organization: 'Acme', country: 'ES', ...mandator },
                mandatee: {
                    id: 'did:key:ana',
                    email: 'ana@acme.org',
                    first_name: 'Ana',
                    last_name: 'López',
                    ...mandatee
                },
                power
            }
        }
    },
    exp: 1_900_000_000
});

describe('claimsFromCredential: a LEAR credential of an employee', () => {
    it('reads the user, the organisation and the roles that the powers give', () => {
        const claims = claimsFromCredential(
            employee([
                { function: 'Onboarding', action: 'Execute' },
                { function: 'ProductOffering', action: ['Create', 'Update'] },
                { function: 'Certification', action: 'uploadCertificate' }
            ]),
            policy
        );

        expect(claims).toEqual({
            id: 'did:key:ana',
            username: 'ana',
            displayName: 'Ana López',
            email: 'ana@acme.org',
            roles: [],
            organizations: [
                {
                    id: 'VATES-1',
                    name: 'Acme',
                    country: 'ES',
                    roles: [
                        { id: 'manager', name: 'manager' },
                        { id: 'seller', name: 'seller' },
                        { id: 'certifier', name: 'certifier' }
                    ]
                }
            ],
            expire: 1_900_000_000,
            issuerDid: 'did:elsi:ISSUER'
        });
    });

    it('reads the function and the action in the three spellings of the issuers', () => {
        for (const power of [
            { function: 'onboarding', action: 'execute' },
            { tmf_function: 'Onboarding', tmf_action: ['Execute'] },
            { tmfFunction: 'ONBOARDING', tmfAction: 'EXECUTE' }
        ]) {
            expect(claimsFromCredential(employee([power]), policy).organizations[0]?.roles).toEqual([
                { id: 'manager', name: 'manager' }
            ]);
        }
    });

    it('makes a seller only of who may create and update product offerings, whatever else the power says', () => {
        const roles = (power: object) => claimsFromCredential(employee([power]), policy).organizations[0]?.roles;
        expect(roles({ function: 'ProductOffering', action: ['Create', 'Update'] })).toEqual([
            { id: 'seller', name: 'seller' }
        ]);
        expect(roles({ function: 'ProductOffering', action: ['Create'] })).toEqual([]);
        // v11 gave the role for any function that could create and update
        expect(roles({ function: 'Catalog', action: ['Create', 'Update'] })).toEqual([]);
    });

    it('does not repeat a role that two powers give, and has none when there are no powers', () => {
        const twice = [
            { function: 'Onboarding', action: 'Execute' },
            { function: 'Onboarding', action: 'Execute' }
        ];
        expect(claimsFromCredential(employee(twice), policy).organizations[0]?.roles).toHaveLength(1);
        expect(claimsFromCredential(employee([]), policy).organizations[0]?.roles).toEqual([]);
        const withoutPowers = employee([]);
        delete (withoutPowers.verifiableCredential.credentialSubject.mandate as { power?: unknown }).power;
        expect(claimsFromCredential(withoutPowers, policy).organizations[0]?.roles).toEqual([]);
    });

    it('makes an administrator of the platform of whoever the issuer or the organisation names as an operator', () => {
        const operators = { ...policy, operators: ['did:elsi:ISSUER'] };
        expect(claimsFromCredential(employee([]), operators).roles).toEqual([{ id: 'admin', name: 'admin' }]);
        expect(claimsFromCredential(employee([], {}, {}, 'did:elsi:ISSUER'), operators).roles).toEqual([
            { id: 'admin', name: 'admin' }
        ]);
        expect(claimsFromCredential(employee([]), { ...policy, operators: ['VATES-1'] }).roles).toEqual([
            { id: 'admin', name: 'admin' }
        ]);
        expect(claimsFromCredential(employee([]), { ...policy, operators: ['other'] }).roles).toEqual([]);
    });

    it('refuses a credential without mandate or without organisation', () => {
        expect(() =>
            claimsFromCredential(
                { verifiableCredential: { type: 'LEARCredentialEmployee', credentialSubject: {} } },
                policy
            )
        ).toThrow(IdpError);
        expect(() => claimsFromCredential(employee([], { organizationIdentifier: undefined }), policy)).toThrow(
            'no organisation'
        );
        expect(() => claimsFromCredential(employee([], {}, { email: undefined }), policy)).toThrow('no user');
    });
});

describe('claimsFromCredential: a LEAR credential of a machine', () => {
    const machine = (mandatee: object, mandator: object = {}, power: object[] = []) => ({
        verifiableCredential: {
            type: ['LEARCredentialMachine'],
            issuer: 'did:elsi:ISSUER',
            credentialSubject: {
                mandate: {
                    mandator: { organizationIdentifier: 'VATES-1', organization: 'Acme', ...mandator },
                    mandatee: { id: 'did:key:bot', ...mandatee },
                    power
                }
            }
        }
    });

    it('takes the address from the contact or from the organisation, and the name from the service', () => {
        expect(
            claimsFromCredential(machine({ serviceName: 'Bot', contact: { email: 'bot@acme.org' } }), policy)
        ).toMatchObject({
            email: 'bot@acme.org',
            displayName: 'Bot Bot',
            username: 'bot'
        });
        expect(
            claimsFromCredential(machine({ serviceName: 'Bot' }, { emailAddress: 'it@acme.org' }), policy).email
        ).toBe('it@acme.org');
    });

    it('does not take `uploadCertificate` as the power of a certifier', () => {
        const roles = (action: string) =>
            claimsFromCredential(machine({ email: 'b@acme.org' }, {}, [{ function: 'certification', action }]), policy)
                .organizations[0]?.roles;
        expect(roles('upload')).toEqual([{ id: 'certifier', name: 'certifier' }]);
        expect(roles('post_verifiable_certification')).toEqual([{ id: 'certifier', name: 'certifier' }]);
        expect(roles('uploadCertificate')).toEqual([]);
    });

    it('knows a machine by the type of the W3C format too', () => {
        const credential = machine({ email: 'b@acme.org' });
        credential.verifiableCredential.type = ['learcredential.machine.w3c.4'] as never;
        expect(claimsFromCredential(credential, policy).email).toBe('b@acme.org');
    });
});

describe('claimsFromCredential: the credential of the issuer of FIWARE', () => {
    const fiware = (subject: object, issuer: unknown = 'did:web:issuer.example.org') => ({
        verifiableCredential: { type: ['VerifiableCredential', 'UserCredential'], issuer, credentialSubject: subject }
    });

    it('makes the user of the address, with the roles it names, in an organisation that is the issuer', () => {
        const claims = claimsFromCredential(
            fiware({
                email: 'bob@example.org',
                firstName: 'Bob',
                familyName: 'Dylan',
                roles: [{ names: ['seller', 'reader'] }, { names: ['other'] }]
            }),
            policy
        );
        expect(claims).toMatchObject({
            id: 'bob@example.org',
            username: 'bob',
            displayName: 'Bob Dylan',
            roles: [
                { id: 'seller', name: 'seller' },
                { id: 'reader', name: 'reader' }
            ],
            issuerDid: 'did:web:issuer.example.org'
        });
        expect(claims.organizations).toEqual([
            {
                id: 'did:web:issuer.example.org',
                name: 'did:web:issuer.example.org',
                roles: ['seller', 'customer', 'manager'].map((name) => ({ id: name, name }))
            }
        ]);
    });

    it('makes up the user of the issuer when there is no address', () => {
        const claims = claimsFromCredential(fiware({ firstName: 'Anon' }), policy);
        expect(claims.id).toBe('did:web:issuer.example.org:individual');
        expect(claims.email).toBe('did.web.issuer.example.org@email.com');
    });
});

describe('claimsFromCredential: where the credential is', () => {
    const inner = employee([]).verifiableCredential;

    it('finds it as it is, or in `vc`, or in a presentation (the LEAR credential first)', () => {
        expect(claimsFromCredential({ ...inner }, policy).id).toBe('did:key:ana');
        expect(claimsFromCredential({ vc: inner }, policy).id).toBe('did:key:ana');
        const other = {
            type: ['VerifiableCredential', 'Other'],
            issuer: 'x',
            credentialSubject: { email: 'o@example.org' }
        };
        expect(claimsFromCredential({ verifiablePresentation: [other, inner] }, policy).id).toBe('did:key:ana');
        expect(claimsFromCredential({ verifiablePresentation: [other] }, policy).id).toBe('o@example.org');
    });

    it('refuses a token that carries none', () => {
        expect(() => claimsFromCredential({ sub: 'x' }, policy)).toThrow('no credential');
        expect(() => claimsFromCredential({ verifiablePresentation: [] }, policy)).toThrow('no credential');
        expect(() => claimsFromCredential({ vc: { type: 'x' } }, policy)).toThrow('no subject');
    });
});
