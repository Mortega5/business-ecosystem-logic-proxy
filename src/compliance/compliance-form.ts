import { normalizeCountry } from '../auth/profile/countries';
import { isRecord } from '../tmf/related-party';

type Json = Record<string, unknown>;

const text = (value: unknown): string =>
    typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : '';
const lower = (value: unknown): string => (typeof value === 'string' ? value.toLowerCase() : '');
const list = (value: unknown): Json[] => (Array.isArray(value) ? value.filter(isRecord) : []);

const characteristicValue = (party: Json, name: string): string => {
    const found = list(party['partyCharacteristic']).find(
        (characteristic) => lower(characteristic['name']) === name.toLowerCase()
    );
    return found?.['value'] ? text(found['value']) : '';
};

const postalAddress = (organization: Json): Json | undefined =>
    list(organization['contactMedium']).find(
        (medium) => lower(medium['mediumType']) === 'postaladdress' && isRecord(medium['characteristic'])
    )?.['characteristic'] as Json | undefined;

const emailOf = (organization: Json): string => {
    const medium = list(organization['contactMedium']).find(
        (candidate) =>
            lower(candidate['mediumType']) === 'email' &&
            isRecord(candidate['characteristic']) &&
            candidate['characteristic']['emailAddress']
    );
    if (medium !== undefined) {
        return text((medium['characteristic'] as Json)['emailAddress']);
    }
    return text(organization['emailAddress'] ?? organization['email']);
};

const addressOf = (organization: Json): string => {
    const address = postalAddress(organization);
    if (address === undefined) {
        return '';
    }
    return [
        address['street1'] || address['street'],
        address['street2'],
        address['postCode'],
        address['city'],
        address['stateOrProvince'],
        address['country']
    ]
        .map(text)
        .filter((part) => part.trim() !== '')
        .join(', ');
};

const countryCode = (value: unknown): string => {
    const country = text(value).trim();
    if (country === '') {
        return '';
    }
    const normalized = normalizeCountry(country);
    return normalized.length === 2 ? normalized.toUpperCase() : '';
};

const countryOf = (organization: Json): string =>
    countryCode(characteristicValue(organization, 'country')) || countryCode(postalAddress(organization)?.['country']);

const vatOf = (organization: Json): string => {
    const reference = list(organization['externalReference']).find(
        (candidate) => candidate['name'] && lower(candidate['externalReferenceType']) === 'idm_id'
    );
    if (reference !== undefined) {
        return text(reference['name']);
    }
    const identification = list(organization['organizationIdentification']).find(
        (candidate) => candidate['identificationId']
    );
    return identification === undefined ? '' : text(identification['identificationId']);
};

/** What the compliance service is told of the organisation that sells the product. */
export const organizationFields = (organization: Json): Record<string, string> => ({
    organization_name: text(organization['tradingName'] ?? organization['name']),
    organization_address: addressOf(organization),
    organization_country: countryOf(organization),
    organization_email: emailOf(organization),
    organization_url: characteristicValue(organization, 'website'),
    organization_vat_id: vatOf(organization)
});

/** The addresses of the files that the product gives for its certificate: the values of its `Compliance:*` characteristics, except the credential. */
export const complianceFileAddresses = (productSpec: Json): string[] => {
    const addresses: string[] = [];
    for (const characteristic of list(productSpec['productSpecCharacteristic'])) {
        const name = lower(characteristic['name']);
        if (!name.startsWith('compliance:') || name === 'compliance:vc') {
            continue;
        }
        for (const value of list(characteristic['productSpecCharacteristicValue'])) {
            if (typeof value['value'] === 'string' && value['value'].trim() !== '') {
                addresses.push(value['value'].trim());
            }
        }
    }
    return addresses;
};
