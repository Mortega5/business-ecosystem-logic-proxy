import { describe, expect, it } from 'vitest';
import { sellerView } from './billing-account';

const ACCOUNT = {
    id: 'urn:ngsi-ld:billing-account:1',
    href: 'urn:ngsi-ld:billing-account:1',
    name: 'Office',
    state: 'Defined',
    '@type': 'BillingAccount',
    accountBalance: [{ amount: 10 }],
    relatedParty: [{ id: 'urn:ngsi-ld:organization:buyer', role: 'Seller' }],
    contact: [
        {
            contactMedium: [
                { mediumType: 'Email', preferred: true, characteristic: { contactType: 'Email', emailAddress: 'ana@example.org', extra: 1 } },
                {
                    mediumType: 'PostalAddress',
                    preferred: true,
                    characteristic: { contactType: 'PostalAddress', street1: 'Calle 1', city: 'Madrid', stateOrProvince: 'Madrid', postCode: '28001', country: 'ES', geo: 'x' }
                },
                { mediumType: 'TelephoneNumber', preferred: true, characteristic: { contactType: 'Mobile', phoneNumber: '+34600111222' } }
            ]
        }
    ]
};

describe('sellerView', () => {
    it('keeps the name, the address, the email and the phone, in the order they came', () => {
        expect(sellerView(ACCOUNT)).toEqual({
            id: ACCOUNT.id,
            href: ACCOUNT.href,
            name: 'Office',
            contact: [
                {
                    contactMedium: [
                        { mediumType: 'Email', characteristic: { contactType: 'Email', emailAddress: 'ana@example.org' } },
                        {
                            mediumType: 'PostalAddress',
                            characteristic: { contactType: 'PostalAddress', street1: 'Calle 1', city: 'Madrid', stateOrProvince: 'Madrid', postCode: '28001', country: 'ES' }
                        },
                        { mediumType: 'TelephoneNumber', characteristic: { contactType: 'Mobile', phoneNumber: '+34600111222' } }
                    ]
                }
            ]
        });
    });

    it('leaves out the owner, the state and any other field', () => {
        const view = sellerView(ACCOUNT);
        expect(Object.keys(view).sort()).toEqual(['contact', 'href', 'id', 'name']);
    });

    it('drops the media it does not know and the ones that are not objects', () => {
        const view = sellerView({ id: 'a', contact: [{ contactMedium: [{ mediumType: 'Fax', characteristic: { number: '1' } }, 'x', null, { mediumType: 'Email', characteristic: { emailAddress: 'a@b.c' } }] }] });
        expect(view['contact']).toEqual([{ contactMedium: [{ mediumType: 'Email', characteristic: { emailAddress: 'a@b.c' } }] }]);
    });

    it('gives an empty contact list when the account has none or it is malformed', () => {
        expect(sellerView({ id: 'a', contact: 'x' })['contact']).toEqual([]);
        expect(sellerView({ id: 'a' })['contact']).toEqual([]);
    });
});
