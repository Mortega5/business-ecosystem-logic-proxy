import { Injectable, Logger } from '@nestjs/common';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { z } from 'zod';
import { BadGatewayError, DomainError, ForbiddenError, NotFoundError } from '../common/domain-error';
import { AppConfigService } from '../config/app-config.service';
import type { UserProfile } from '../auth/profile/user-profile';
import { isRecord } from '../tmf/related-party';
import { parseJson } from '../tmf/specification/specifications';
import { TmfProxy } from '../tmf/tmf-proxy';
import type { UpstreamUser } from '../tmf/upstream-headers';

const CREDENTIAL = 'compliance:vc';
// A credential is a signed token with a certificate chain: a few kilobytes
const MAX_CREDENTIAL_CHARS = 64 * 1024;

const body = z.looseObject({ vc: z.string().min(1).max(MAX_CREDENTIAL_CHARS) });

type Caller = UpstreamUser & { roles?: { name: string }[], organizations?: UserProfile['organizations'] };

const hasRole = (roles: { name: string }[] | undefined, role: string): boolean =>
    (roles ?? []).some((candidate) => candidate.name.toLowerCase() === role.toLowerCase());

/**
 * The compliance credential of a product, which a certifier puts in it as the characteristic `Compliance:VC`. A seller cannot write it
 * (the products do not take it from them), so this is the only way in; it is checked at launch, where its signature and its certificate
 * are looked at.
 */
@Injectable()
export class CertificateService {
    private readonly logger = new Logger(CertificateService.name);

    constructor(
        private readonly proxy: TmfProxy,
        private readonly config: AppConfigService
    ) {}

    async upload(req: Request, specId: string, rawBody: string): Promise<void> {
        const user = (req as Request & { user?: Caller }).user;
        if (!this.mayCertify(user)) {
            throw new ForbiddenError('You are not authorized to upload certificates');
        }
        const parsed = body.safeParse(JSON.parse(rawBody));
        if (!parsed.success) {
            throw new DomainError(
                parsed.error.issues.some((issue) => issue.path[0] === 'vc' && issue.code !== 'invalid_type')
                    ? 'Invalid VC'
                    : 'Missing VC',
                400
            );
        }
        const { vc } = parsed.data;
        if (jwt.decode(vc, { complete: true }) === null) {
            throw new DomainError('The credential has to be a signed token (JWT)', 422);
        }

        const path = `/productSpecification/${encodeURIComponent(specId)}`;
        const current = await this.proxy.send(req, { upstream: 'tmforum.catalog', path, method: 'GET', search: '' });
        if (current.status === 404) {
            throw new NotFoundError('The product spec does not exist');
        }
        const spec = parseJson(current.body);
        if (current.status >= 400 || !isRecord(spec)) {
            this.logger.warn({ specId, statusCode: current.status }, 'The catalog could not give the product specification');
            throw new BadGatewayError('The product specification could not be read');
        }

        const kept = (
            Array.isArray(spec['productSpecCharacteristic']) ? (spec['productSpecCharacteristic'] as unknown[]) : []
        ).filter(
            (characteristic) =>
                !(
                    isRecord(characteristic) &&
                    typeof characteristic['name'] === 'string' &&
                    characteristic['name'].toLowerCase() === CREDENTIAL
                )
        );
        kept.push({
            id: `urn:ngsi-ld:characteristic:${randomUUID()}`,
            name: 'Compliance:VC',
            productSpecCharacteristicValue: [{ isDefault: true, value: vc }]
        });

        const updated = await this.proxy.send(req, {
            upstream: 'tmforum.catalog',
            path,
            method: 'PATCH',
            body: JSON.stringify({ productSpecCharacteristic: kept }),
            contentType: 'application/json',
            search: ''
        });
        if (updated.status >= 400) {
            this.logger.warn({ specId, statusCode: updated.status }, 'The catalog did not accept the credential of a product specification')
            throw new BadGatewayError('The credential could not be saved in the product specification');
        }
        this.logger.log(
            `The compliance credential of the product specification ${specId} was uploaded by ${user?.id ?? 'unknown'}`
        );
    }

    /** An administrator, whoever has the role of certifier, and whoever is a member of an organisation that has it. */
    private mayCertify(user: Caller | undefined): boolean {
        if (user === undefined) {
            return false;
        }
        const certifier = this.config.auth.roles.certifier;
        return (
            hasRole(user.roles, this.config.auth.roles.admin) ||
            hasRole(user.roles, certifier) ||
            (user.organizations ?? []).some((organization) => hasRole(organization.roles, certifier))
        );
    }
}
