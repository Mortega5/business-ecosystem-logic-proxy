import { describe, expect, it } from 'vitest';
import { DomainError } from '../../common/domain-error';
import { certificationSubject } from './vc-certificate';

const ISSUER = 'did:web:certifier.example.org';
const NOW = Date.parse('2026-01-01T00:00:00Z');
const credential = (extra: Record<string, unknown> = {}) => ({
    verifiableCredential: {
        issuer: { did: ISSUER },
        expirationDate: '2027-01-01T00:00:00Z',
        subject: { product: 'urn:ngsi-ld:product-specification:1', compliance: [{ id: 'iso27001' }] },
        ...extra
    }
});

describe('certificationSubject', () => {
    it('gives what the credential certifies when it is from a trusted issuer, has not expired and is about a product', () => {
        expect(certificationSubject(credential(), [ISSUER], () => NOW)).toEqual({
            product: 'urn:ngsi-ld:product-specification:1',
            compliance: [{ id: 'iso27001' }]
        });
    });

    it('refuses with 400 a token that has no credential, an issuer that is not trusted, an expired one and a subject that does not say what it certifies', () => {
        const refused = (payload: Record<string, unknown>, issuers = [ISSUER]) => {
            try {
                certificationSubject(payload, issuers, () => NOW);
            } catch (error) {
                return error as DomainError;
            }
            return undefined;
        };
        expect(refused({})).toMatchObject({ status: 400, message: 'Invalid VC' });
        expect(refused(credential(), [])).toMatchObject({ status: 400, message: 'Invalid VC issuer' });
        expect(refused(credential({ issuer: 'did:web:certifier.example.org' }))).toMatchObject({
            message: 'Invalid VC issuer'
        });
        expect(refused(credential({ expirationDate: '2025-01-01T00:00:00Z' }))).toMatchObject({
            message: 'The VC is expired'
        });
        expect(refused(credential({ expirationDate: 'soon' }))).toMatchObject({ message: 'The VC is expired' });
        expect(refused(credential({ subject: { product: 'x' } }))).toMatchObject({ message: 'Invalid VC subject' });
        expect(refused(credential({ subject: 'x' }))).toMatchObject({ message: 'Invalid VC subject' });
    });
});
