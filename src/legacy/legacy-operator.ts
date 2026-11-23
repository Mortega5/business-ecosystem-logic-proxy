import { Injectable } from '@nestjs/common';

/**
 * The operator of the marketplace is found by the legacy application when it starts, and again every night, and kept in memory
 * with the roles and the identifier it is configured with. What is created here has to name it where v11 did.
 */
@Injectable()
export class LegacyOperator {
    /** The operator as the related party of what a seller creates, or nothing when the marketplace has none. */
    seller(): Record<string, unknown> | undefined {
        return this.as('sellerOperator');
    }

    /** The operator as the related party of what a buyer orders, or nothing when the marketplace has none. */
    buyer(): Record<string, unknown> | undefined {
        return this.as('buyerOperator');
    }

    /** The operator as the owner of what the platform creates (its seller and its seller operator), or nothing when there is none. */
    owner(): Record<string, unknown>[] | undefined {
        const owner = this.as('seller');
        const operator = this.as('sellerOperator');
        return owner === undefined || operator === undefined ? undefined : [owner, operator];
    }

    private as(role: 'seller' | 'sellerOperator' | 'buyerOperator'): Record<string, unknown> | undefined {
        const { operator } = require('../../lib/operator') as { operator: { getOperatorId: () => string | undefined } };
        const config = require('../../config') as { operatorId: string; roles: Record<typeof role, string> };
        const id = operator.getOperatorId();
        if (id === undefined || id === '') {
            return undefined;
        }
        return { id, href: id, name: config.operatorId, role: config.roles[role], '@referredType': 'Organization' };
    }
}
