import { describe, expect, it, vi } from 'vitest';
import { BadGatewayError, ForbiddenError } from '../common/domain-error';
import type { AppConfigService } from '../config/app-config.service';
import { FileGuards, OWNER_LABEL } from './file-guards';
import type { FileServiceClient, StoredFile } from './file-service.client';

const ID = '3f2b8c6e-1a4d-4e7b-9c3a-5d6e7f8a9b0c';
const OTHER = '5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d';

const setup = (files: Record<string, StoredFile | undefined>, enabled = true) => {
    const find = vi.fn((id: string) => Promise.resolve(files[id]));
    const guards = new FileGuards(
        { find } as unknown as FileServiceClient,
        { fileService: { enabled } } as unknown as AppConfigService
    );
    return { guards, find };
};
const owned = (partyId: string): StoredFile => ({ fileId: 'f', labels: { [OWNER_LABEL]: partyId } });
const service = (...ids: string[]) => ({
    specCharacteristic: [{ name: 'fileId', characteristicValueSpecification: ids.map((value) => ({ value })) }]
});
const product = (...paths: string[]) => ({
    productSpecCharacteristic: [{ valueType: 'authorizationPolicy', productSpecCharacteristicValue: paths }]
});

describe('FileGuards: the files of a service specification', () => {
    it('lets the seller point at their own files, and asks about each file once', async () => {
        const { guards, find } = setup({ [ID]: owned('p-ana') });
        await expect(guards.checkServiceSpecFiles(service(ID, ID), 'p-ana')).resolves.toBeUndefined();
        expect(find).toHaveBeenCalledTimes(1);
    });

    it('refuses a file of another party, a file that does not exist, and one without owner', async () => {
        const { guards } = setup({ [ID]: owned('p-bob'), [OTHER]: { fileId: 'f' } });
        await expect(guards.checkServiceSpecFiles(service(ID), 'p-ana')).rejects.toBeInstanceOf(ForbiddenError);
        await expect(guards.checkServiceSpecFiles(service(OTHER), 'p-ana')).rejects.toBeInstanceOf(ForbiddenError);
        await expect(guards.checkServiceSpecFiles(service('missing'), 'p-ana')).rejects.toBeInstanceOf(ForbiddenError);
        await expect(guards.checkServiceSpecFiles(service(ID), undefined)).rejects.toBeInstanceOf(ForbiddenError);
    });

    it('has nothing to check in a specification that names no file', async () => {
        const { guards, find } = setup({});
        await expect(guards.checkServiceSpecFiles({}, 'p-ana')).resolves.toBeUndefined();
        await expect(guards.checkServiceSpecFiles(null, 'p-ana')).resolves.toBeUndefined();
        expect(find).not.toHaveBeenCalled();
    });
});

describe('FileGuards: the files of an access policy', () => {
    it('lets a policy name the files of the seller, and one that does not exist yet', async () => {
        const { guards } = setup({ [ID]: owned('p-ana') });
        await expect(
            guards.checkProductSpecFiles(product(`/private/${ID}`, `/private/${OTHER}`), 'p-ana')
        ).resolves.toBeUndefined();
    });

    it('refuses a policy that names a file of another party', async () => {
        const { guards } = setup({ [ID]: owned('p-bob') });
        await expect(guards.checkProductSpecFiles(product(`/private/${ID}`), 'p-ana')).rejects.toThrow(
            `the file ${ID}`
        );
    });

    it('refuses a policy that could reach files without naming one', async () => {
        const { guards, find } = setup({});
        await expect(guards.checkProductSpecFiles(product('/private/.*'), 'p-ana')).rejects.toBeInstanceOf(
            ForbiddenError
        );
        expect(find).not.toHaveBeenCalled();
    });
});

describe('FileGuards: when it cannot check, and when there is nothing to guard', () => {
    it('does not take a check that failed for a pass', async () => {
        const guards = new FileGuards(
            { find: () => Promise.reject(new Error('down')) } as unknown as FileServiceClient,
            { fileService: { enabled: true } } as unknown as AppConfigService
        );
        await expect(guards.checkProductSpecFiles(product(`/private/${ID}`), 'p-ana')).rejects.toBeInstanceOf(
            BadGatewayError
        );
        await expect(guards.checkServiceSpecFiles(service(ID), 'p-ana')).rejects.toBeInstanceOf(BadGatewayError);
    });

    it('does not guard without a file service', async () => {
        const { guards, find } = setup({}, false);
        await expect(guards.checkProductSpecFiles(product('/private/.*'), 'p-ana')).resolves.toBeUndefined();
        await expect(guards.checkServiceSpecFiles(service(ID), 'p-ana')).resolves.toBeUndefined();
        expect(find).not.toHaveBeenCalled();
    });
});
