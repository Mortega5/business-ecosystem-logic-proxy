import { Injectable } from '@nestjs/common';

/**
 * The operator of the marketplace is found by the legacy application when it starts, and again every night, and kept in memory
 * with the roles and the identifier it is configured with. What is created here has to name it where v11 did.
 */
@Injectable()
export class LegacyOperator {
    /** The operator as the related party of what a seller creates, or nothing when the marketplace has none. */
    seller(): Record<string, unknown> | undefined {
        const { operator } = require('../../lib/operator') as { operator: { getOperatorId: () => string | undefined } };
        const config = require('../../config') as { operatorId: string; roles: { sellerOperator: string } };
        const id = operator.getOperatorId();
        if (id === undefined || id === '') {
            return undefined;
        }
        return { id, href: id, name: config.operatorId, role: config.roles.sellerOperator, '@referredType': 'Organization' };
    }
}
