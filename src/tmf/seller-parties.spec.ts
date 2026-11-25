import { describe, expect, it } from 'vitest';
import type { OperatorService } from '../operator/operator.service';
import { SellerParties } from './seller-parties';

const OPERATOR = { id: 'urn:ngsi-ld:organization:op', href: 'urn:ngsi-ld:organization:op', name: 'did:elsi:VATES-1', role: 'SellerOperator', '@referredType': 'Organization' };
const without = { seller: () => undefined } as unknown as OperatorService;
const with_ = { seller: () => OPERATOR } as unknown as OperatorService;
const user = { id: 'u-sam', partyId: 'p-shop' };

describe('the related parties of what a seller creates', () => {
    it('are the seller, named by their user, as an individual', () => {
        expect(new SellerParties(without).of({ id: 'urn:ngsi-ld:individual:1', role: 'Seller' }, user)).toEqual([
            { id: 'urn:ngsi-ld:individual:1', href: 'urn:ngsi-ld:individual:1', name: 'u-sam', role: 'Seller', '@referredType': 'Individual' }
        ]);
    });

    it('type an organisation as such', () => {
        const [seller] = new SellerParties(without).of({ id: 'urn:ngsi-ld:organization:1', role: 'Seller' }, user);
        expect(seller).toMatchObject({ '@referredType': 'Organization' });
    });

    it('take nothing from the client but the id and the role, so the href cannot point anywhere else', () => {
        const [seller] = new SellerParties(without).of({ id: 'p-shop', role: 'Seller', href: 'https://evil.example', name: 'Somebody', '@referredType': 'Organization' }, user);
        expect(seller).toEqual({ id: 'p-shop', href: 'p-shop', name: 'u-sam', role: 'Seller', '@referredType': 'Individual' });
    });

    it('name the operator of the marketplace after the seller, when there is one', () => {
        expect(new SellerParties(with_).of({ id: 'p-shop', role: 'Seller' }, user)).toEqual([
            { id: 'p-shop', href: 'p-shop', name: 'u-sam', role: 'Seller', '@referredType': 'Individual' },
            OPERATOR
        ]);
    });
});
