import { z } from 'zod';
import { isResourceId } from '../resource-id.pipe';

const reference = z.looseObject({ id: z.string().refine(isResourceId) });

/**
 * The order to price: what the portal sends of the cart. The items and the billing account are checked, as the parties and the
 * account are built from them; the rest of the order goes on to the billing engine as it came.
 */
export const orderSimulation = z.looseObject({
    productOrder: z.looseObject({
        productOrderItem: z.array(z.looseObject({ productOffering: reference })).min(1).max(100),
        billingAccount: reference.optional()
    })
});

export type OrderSimulation = z.infer<typeof orderSimulation>;
