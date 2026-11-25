import { Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { DomainError } from '../../common/domain-error';
import { AppConfigService } from '../../config/app-config.service';
import { OperatorService } from '../../operator/operator.service';
import { NormalizedParties } from '../normalized-parties';
import { isRecord } from '../related-party';
import type { UpstreamUser } from '../upstream-headers';

type Json = Record<string, unknown>;

/**
 * The related parties of what a seller makes for the catalog and may make for one buyer (an offering, a price), as v11 wrote them:
 * the buyer, if the body names one, and the operator as buyer when it names anybody; then the caller as the seller, and the
 * operator as their seller. What the client says about the seller is not looked at.
 */
@Injectable()
export class OfferingParties {
    constructor(
        private readonly config: AppConfigService,
        private readonly operator: OperatorService,
        private readonly parties: NormalizedParties
    ) {}

    /** Each related party is an object with an id and a role, which v11 did not check (a `null` there ended its process). */
    assertShape(sent: unknown): void {
        if (sent === undefined || sent === null) {
            return;
        }
        if (!Array.isArray(sent) || sent.some((party) => !isRecord(party) || typeof party['role'] !== 'string' || typeof party['id'] !== 'string')) {
            throw new DomainError('Invalid related party', 400);
        }
    }

    async of(req: Request, sent: unknown, partyId: string): Promise<Json[]> {
        const { roles } = this.config.auth;
        const user = (req as Request & { user: UpstreamUser }).user;
        const result: Json[] = [];
        if (sent !== undefined && sent !== null) {
            this.assertShape(sent);
            const parties = sent as Json[];
            if (parties.length > 0) {
                const buyer = parties.find((party) => String(party['role']).toLowerCase() === roles.customer.toLowerCase());
                if (buyer !== undefined) {
                    const id = buyer['id'] as string;
                    result.push(await this.parties.of(req, user, { id, href: typeof buyer['href'] === 'string' ? buyer['href'] : id, role: buyer['role'] as string }));
                }
                const buyerOperator = this.operator.buyer();
                if (buyerOperator !== undefined) {
                    result.push(buyerOperator);
                }
            }
        }
        result.push(await this.parties.of(req, user, { id: partyId, href: partyId, role: roles.seller }));
        const sellerOperator = this.operator.seller();
        if (sellerOperator !== undefined) {
            result.push(sellerOperator);
        }
        return result;
    }
}
