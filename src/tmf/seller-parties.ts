import { Injectable } from '@nestjs/common';
import { OperatorService } from '../operator/operator.service';
import type { UpstreamUser } from './upstream-headers';

/**
 * The related parties of what a seller creates, as v11 wrote them: the seller, named by their user and typed as an individual or
 * an organisation, and the operator of the marketplace when there is one. The seller is the caller, so the party is not looked up.
 */
@Injectable()
export class SellerParties {
    constructor(private readonly operator: OperatorService) {}

    of(seller: Record<string, unknown>, user: UpstreamUser): Record<string, unknown>[] {
        const id = String(seller['id']);
        const caller = {
            id,
            href: id,
            name: user.id,
            role: seller['role'],
            '@referredType': id.includes('organization') ? 'Organization' : 'Individual'
        };
        const operator = this.operator.seller();
        return operator === undefined ? [caller] : [caller, operator];
    }
}
