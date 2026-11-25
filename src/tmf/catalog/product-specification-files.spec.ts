import type { Request } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { ForbiddenError } from '../../common/domain-error';
import type { AppConfigService } from '../../config/app-config.service';
import type { FileGuards } from '../../files/file-guards';
import type { OwnedResources } from '../owned-resources';
import type { SellerParties } from '../seller-parties';
import type { TmfProxy } from '../tmf-proxy';
import type { ChargingAssets } from '../charging-assets';
import type { PriceReferences } from './price-references';
import { ProductSpecifications } from './product-specifications';

type Validation = { assertValid: (req: Request, product: object, previous: unknown[] | null) => Promise<void> };

const setup = () => {
    const checkProductSpecFiles = vi.fn().mockResolvedValue(undefined);
    const specifications = new ProductSpecifications(
        {} as TmfProxy,
        {} as OwnedResources,
        {} as AppConfigService,
        {} as SellerParties,
        {} as ChargingAssets,
        {} as PriceReferences,
        { checkProductSpecFiles } as unknown as FileGuards
    ) as unknown as Validation;
    return { specifications, checkProductSpecFiles, req: { user: { partyId: 'p-ana' } } as unknown as Request };
};

describe('ProductSpecifications: the files that its access policy names', () => {
    it('checks them against the party that makes the product, on a create and on a change', async () => {
        const { specifications, checkProductSpecFiles, req } = setup();
        const product = { name: 'dataset' };
        await specifications.assertValid(req, product, null);
        expect(checkProductSpecFiles).toHaveBeenCalledWith(product, 'p-ana');
    });

    it("refuses the product when the policy grants a file that is not the seller's", async () => {
        const { specifications, checkProductSpecFiles, req } = setup();
        checkProductSpecFiles.mockRejectedValue(
            new ForbiddenError('The access policy grants access to the file f-1, which is not one of your files')
        );
        await expect(specifications.assertValid(req, {}, null)).rejects.toBeInstanceOf(ForbiddenError);
    });
});
