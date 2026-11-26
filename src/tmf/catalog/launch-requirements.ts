import { X509Certificate } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import type { Request } from 'express';
import jwt, { type JwtPayload } from 'jsonwebtoken';
import { AppConfigService } from '../../config/app-config.service';
import { FeatureFlagService } from '../../features/feature-flag.service';
import { isRecord } from '../related-party';
import { isResourceId } from '../resource-id.pipe';
import { parseJson } from '../specification/specifications';
import { TmfProxy } from '../tmf-proxy';

type Json = Record<string, unknown>;

const LABELS = ['BL', 'P', 'PP'];
const CREDENTIAL_TYPES = new Set(['gx:labelcredential', 'gx.labelcredential.w3c.2']);
const ISSUER_PREFIX = 'did:elsi:';
const IMAGE_TYPES = new Set(['image/svg+xml', 'image/png', 'image/jpeg', 'image/gif']);

const hasText = (value: unknown): boolean => (typeof value === 'string' ? value.trim() !== '' : value != null);
const lower = (value: unknown): string => (typeof value === 'string' ? value.trim().toLowerCase() : '');

/** Whether a product specification has a profile picture of a type that can be shown. */
export const hasProfilePicture = (product: Json): boolean =>
    Array.isArray(product['attachment']) &&
    product['attachment'].some((attachment) => isRecord(attachment) && lower(attachment['name']) === 'profile picture' && IMAGE_TYPES.has(lower(attachment['attachmentType'])) && typeof attachment['url'] === 'string' && attachment['url'].trim() !== '');

/** A profile picture that is not an image that can be shown, which a product specification cannot have. */
export const hasInvalidProfilePicture = (product: Json): boolean =>
    Array.isArray(product['attachment']) &&
    product['attachment'].some((attachment) => isRecord(attachment) && lower(attachment['name']) === 'profile picture' && !IMAGE_TYPES.has(lower(attachment['attachmentType'])));

const complianceToken = (product: Json): string | undefined => {
    const found = (Array.isArray(product['productSpecCharacteristic']) ? product['productSpecCharacteristic'] : []).filter(
        (characteristic) => isRecord(characteristic) && lower(characteristic['name']) === 'compliance:vc'
    ) as Json[];
    const values = found.length === 1 ? found[0]?.['productSpecCharacteristicValue'] : undefined;
    const value = Array.isArray(values) && values.length === 1 && isRecord(values[0]) ? values[0]['value'] : undefined;
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
};

const certificateOf = (token: string): string | undefined => {
    const decoded = jwt.decode(token, { complete: true });
    const chain: unknown = decoded?.header['x5c'];
    const first = Array.isArray(chain) && typeof chain[0] === 'string' ? chain[0].replaceAll(/\s/g, '') : '';
    return first === '' ? undefined : `-----BEGIN CERTIFICATE-----\n${first.match(/.{1,64}/g)?.join('\n') ?? ''}\n-----END CERTIFICATE-----`;
};

const organizationIdentifier = (certificate: X509Certificate): string | undefined => {
    const subject = (certificate.toLegacyObject() as { subject?: Record<string, unknown> }).subject;
    const raw = subject?.['organizationIdentifier'] ?? subject?.['2.5.4.97'] ?? subject?.['OID.2.5.4.97'];
    const values = Array.isArray(raw) ? raw : [raw];
    return values.length === 1 && typeof values[0] === 'string' && values[0].trim() !== '' ? values[0].trim() : undefined;
};

const issuerOf = (payload: JwtPayload, credential: Json): string | undefined => {
    for (const issuer of [payload['iss'], credential['issuer']]) {
        if (typeof issuer === 'string' && issuer.trim() !== '') {
            return issuer.trim();
        }
        if (isRecord(issuer) && typeof issuer['id'] === 'string' && issuer['id'].trim() !== '') {
            return issuer['id'].trim();
        }
    }
    return undefined;
};

/**
 * What an offering has to meet to be launched when the marketplace asks for it: its product has a profile picture, its seller is an
 * organisation that says its country and is not just initialised, and the product carries a compliance credential that is signed with
 * the certificate that comes with it, whose holder is the issuer, for this product and with one of the labels. The credential brings
 * its own certificate and there is no trusted root yet, so what the certificate vouches for is only that it is the one that signed;
 * the marketplace chooses whether to take that (and then it is told in the log each time) or to refuse it.
 */
@Injectable()
export class LaunchRequirements {
    private readonly logger = new Logger(LaunchRequirements.name);

    constructor(
        private readonly proxy: TmfProxy,
        private readonly config: AppConfigService,
        private readonly features: FeatureFlagService
    ) {}

    /** Whether launches are checked at all. */
    enabled(): Promise<boolean> {
        return this.features.isEnabled('launchValidation');
    }

    /** What the offering does not meet, or nothing when it meets it; the reason is for the log, the client is told only that it does not. */
    async unmet(req: Request, offering: Json, product: Json): Promise<string | undefined> {
        if (offering['isBundle'] === true) {
            return 'it is a bundle';
        }
        if (!hasProfilePicture(product)) {
            return 'its product has no profile picture that can be shown';
        }
        const sellerId = this.organizationSeller(offering);
        if (sellerId === undefined) {
            return 'its seller is not an organisation';
        }
        const organization = await this.organization(req, sellerId);
        if (organization === undefined) {
            return `its seller ${sellerId} could not be read`;
        }
        const characteristics = Array.isArray(organization['partyCharacteristic']) ? organization['partyCharacteristic'] : [];
        const hasCountry = characteristics.some((one) => isRecord(one) && lower(one['name']) === 'country' && hasText(one['value']));
        if (!hasCountry) {
            return `its seller ${sellerId} has no country`;
        }
        if (lower(organization['status']) === 'initialized') {
            return `its seller ${sellerId} is not active yet`;
        }
        return this.credentialProblem(product);
    }

    private organizationSeller(offering: Json): string | undefined {
        const seller = this.config.auth.roles.seller.toLowerCase();
        const parties = Array.isArray(offering['relatedParty']) ? offering['relatedParty'] : [];
        const found = parties.find(
            (party) => isRecord(party) && typeof party['id'] === 'string' && lower(party['role']) === seller && (lower(party['@referredType']) === 'organization' || party['id'].toLowerCase().includes('organization'))
        ) as Json | undefined;
        return found === undefined ? undefined : (found['id'] as string);
    }

    private async organization(req: Request, id: string): Promise<Json | undefined> {
        if (!isResourceId(id)) {
            return undefined;
        }
        const response = await this.proxy.send(req, { upstream: 'tmforum.party', path: `/organization/${encodeURIComponent(id)}`, method: 'GET', search: '' });
        const found = parseJson(response.body);
        return response.status < 400 && isRecord(found) ? found : undefined;
    }

    private credentialProblem(product: Json): string | undefined {
        const token = complianceToken(product);
        if (token === undefined || typeof product['id'] !== 'string') {
            return 'its product has no compliance credential';
        }
        try {
            const pem = certificateOf(token);
            if (pem === undefined) {
                return 'the compliance credential has no certificate';
            }
            const payload = jwt.verify(token, pem, { algorithms: ['RS256'] });
            if (!isRecord(payload)) {
                return 'the compliance credential is not valid';
            }
            const nested = (payload['verifiableCredential'] ?? payload['vc'] ?? payload) as unknown;
            const credential = isRecord(nested) && isRecord(nested['credentialSubject']) ? nested : undefined;
            if (credential === undefined) {
                return 'the compliance credential has no subject';
            }
            const holder = organizationIdentifier(new X509Certificate(pem));
            if (holder === undefined || issuerOf(payload, credential) !== `${ISSUER_PREFIX}${holder}`) {
                return 'the issuer of the compliance credential is not the holder of its certificate';
            }
            const types = Array.isArray(credential['type']) ? credential['type'] : [credential['type']];
            if (!types.some((type) => CREDENTIAL_TYPES.has(lower(type)))) {
                return 'the compliance credential is not a label credential';
            }
            const subject = credential['credentialSubject'] as Json;
            if (subject['id'] !== product['id']) {
                return 'the compliance credential is for another product';
            }
            const label = subject['gx:labelLevel'];
            if (typeof label !== 'string' || !LABELS.includes(label.trim().toUpperCase())) {
                return 'the compliance credential has no label that is accepted';
            }
        } catch {
            return 'the compliance credential could not be verified';
        }
        if (!this.config.launchValidation.allowUntrustedCertificates) {
            return 'the certificate of the compliance credential is not anchored to a trusted root';
        }
        this.logger.warn(`The compliance credential of the product ${String(product['id'])} was taken with a certificate that is not anchored to a trusted root`);
        return undefined;
    }
}
