import { describe, expect, it } from 'vitest';
import { complianceFileAddresses, organizationFields } from './compliance-form';

describe('organizationFields', () => {
    it('tells of the organisation as the compliance service wants it', () => {
        expect(
            organizationFields({
                tradingName: 'Acme',
                contactMedium: [
                    { mediumType: 'Email', characteristic: { emailAddress: 'info@acme.example' } },
                    {
                        mediumType: 'PostalAddress',
                        characteristic: { street1: 'Calle 1', postCode: '28001', city: 'Madrid', country: 'Spain' }
                    }
                ],
                partyCharacteristic: [
                    { name: 'country', value: 'Spain' },
                    { name: 'Website', value: 'https://acme.example' }
                ],
                externalReference: [{ externalReferenceType: 'idm_id', name: 'VATES-A12345678' }]
            })
        ).toEqual({
            organization_name: 'Acme',
            organization_address: 'Calle 1, 28001, Madrid, Spain',
            organization_country: 'ES',
            organization_email: 'info@acme.example',
            organization_url: 'https://acme.example',
            organization_vat_id: 'VATES-A12345678'
        });
    });

    it('takes the country from the address when the organisation has no characteristic for it, and the VAT from its identification', () => {
        expect(
            organizationFields({
                name: 'Beta',
                email: 'beta@example.org',
                contactMedium: [{ mediumType: 'postalAddress', characteristic: { country: 'FR' } }],
                organizationIdentification: [{ identificationId: 'FR123' }]
            })
        ).toMatchObject({
            organization_name: 'Beta',
            organization_country: 'FR',
            organization_email: 'beta@example.org',
            organization_vat_id: 'FR123'
        });
    });

    it('leaves empty what it does not know, and a country that is not a code', () => {
        expect(organizationFields({ partyCharacteristic: [{ name: 'country', value: 'Atlantis' }] })).toEqual({
            organization_name: '',
            organization_address: '',
            organization_country: '',
            organization_email: '',
            organization_url: '',
            organization_vat_id: ''
        });
    });
});

describe('complianceFileAddresses', () => {
    it('collects the values of the compliance characteristics, except the credential', () => {
        const product = {
            productSpecCharacteristic: [
                {
                    name: 'Compliance:ISO27001',
                    productSpecCharacteristicValue: [
                        { value: ' https://files.example.org/iso.pdf ' },
                        { value: '' },
                        { value: 3 }
                    ]
                },
                {
                    name: 'compliance:SelfAtt',
                    productSpecCharacteristicValue: [{ value: 'https://files.example.org/self.pdf' }]
                },
                { name: 'Compliance:VC', productSpecCharacteristicValue: [{ value: 'eyJ.credential.token' }] },
                { name: 'Other', productSpecCharacteristicValue: [{ value: 'https://files.example.org/other.pdf' }] }
            ]
        };
        expect(complianceFileAddresses(product)).toEqual([
            'https://files.example.org/iso.pdf',
            'https://files.example.org/self.pdf'
        ]);
    });

    it('is empty for a product that has no characteristics or has them wrong', () => {
        expect(complianceFileAddresses({})).toEqual([]);
        expect(complianceFileAddresses({ productSpecCharacteristic: 'x' })).toEqual([]);
        expect(
            complianceFileAddresses({
                productSpecCharacteristic: [{ name: 'Compliance:A', productSpecCharacteristicValue: 'x' }]
            })
        ).toEqual([]);
    });
});
