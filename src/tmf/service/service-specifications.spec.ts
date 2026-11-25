import type { Request } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { ForbiddenError } from '../../common/domain-error';
import type { AppConfigService } from '../../config/app-config.service';
import type { FileGuards } from '../../files/file-guards';
import type { OwnedResources } from '../owned-resources';
import type { SellerParties } from '../seller-parties';
import type { TmfProxy } from '../tmf-proxy';
import { ServiceSpecifications } from './service-specifications';

type Checks = {
    beforeCreate: (req: Request, spec: object) => Promise<unknown>,
    beforeUpdate: (req: Request, id: string, current: object, changes: object) => Promise<unknown>
};

const setup = () => {
    const checkServiceSpecFiles = vi.fn().mockResolvedValue(undefined);
    const specifications = new ServiceSpecifications(
        {} as TmfProxy,
        {} as OwnedResources,
        {} as AppConfigService,
        {} as SellerParties,
        { checkServiceSpecFiles } as unknown as FileGuards
    ) as unknown as Checks;
    return { specifications, checkServiceSpecFiles, req: { user: { partyId: 'p-ana' } } as unknown as Request };
};

describe('ServiceSpecifications: the files a service specification points at', () => {
    it('checks on a create that they are the files of the party that makes it', async () => {
        const { specifications, checkServiceSpecFiles, req } = setup();
        const spec = { name: 'dataset' };
        await specifications.beforeCreate(req, spec);
        expect(checkServiceSpecFiles).toHaveBeenCalledWith(spec, 'p-ana');
    });

    it('checks on a change what the change sends', async () => {
        const { specifications, checkServiceSpecFiles, req } = setup();
        const changes = { description: 'new' };
        await specifications.beforeUpdate(req, 'urn:ngsi-ld:service-specification:1', { name: 'old' }, changes);
        expect(checkServiceSpecFiles).toHaveBeenCalledWith(changes, 'p-ana');
    });

    it("does not let the request go on when a file is not the seller's", async () => {
        const { specifications, checkServiceSpecFiles, req } = setup();
        checkServiceSpecFiles.mockRejectedValue(new ForbiddenError('The file f-1 is not one of your files'));
        await expect(specifications.beforeCreate(req, {})).rejects.toBeInstanceOf(ForbiddenError);
        await expect(specifications.beforeUpdate(req, 'id', {}, {})).rejects.toBeInstanceOf(ForbiddenError);
    });
});
