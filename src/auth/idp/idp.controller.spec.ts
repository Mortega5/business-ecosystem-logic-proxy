import { describe, expect, it, vi } from 'vitest';
import { DomainError } from '../../common/domain-error';
import { IdpController } from './idp.controller';
import type { IdpService } from './idp.service';

const setup = () => {
    const service = {
        list: vi.fn().mockResolvedValue([]),
        get: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        remove: vi.fn()
    };
    const setHeader = vi.fn();
    return {
        service,
        setHeader,
        controller: new IdpController(service as unknown as IdpService),
        res: { setHeader } as never
    };
};

const body = (value: unknown): string => JSON.stringify(value);
const valid = { idpId: 'EU.EORI.IDP1', name: 'Idp', server: 'https://idp.example.org' };

describe('IdpController', () => {
    it('lists, optionally searching, and reads one', async () => {
        const { controller, service } = setup();
        await controller.list('word');
        await controller.list('');
        await controller.get('EU.EORI.IDP1');
        expect(service.list).toHaveBeenNthCalledWith(1, 'word');
        expect(service.list).toHaveBeenNthCalledWith(2, undefined);
        expect(service.get).toHaveBeenCalledWith('EU.EORI.IDP1');
    });

    it('adds one and says where it is', async () => {
        const { controller, service, setHeader, res } = setup();
        await controller.create(body(valid), res);
        expect(service.create).toHaveBeenCalledWith(valid);
        expect(setHeader).toHaveBeenCalledWith('location', '/IDP/EU.EORI.IDP1');
    });

    it('refuses what is not an identity provider: other fields, ids that need escaping, addresses that are not http, no name', async () => {
        const { controller, service, res } = setup();
        for (const wrong of [
            { ...valid, extra: 1 },
            { ...valid, idpId: '../admin' },
            { ...valid, idpId: 'a b' },
            { ...valid, server: 'javascript:alert(1)' },
            { ...valid, server: 'file:///etc/passwd' },
            { ...valid, name: '' },
            { idpId: 'x', server: valid.server }
        ]) {
            await expect(controller.create(body(wrong), res)).rejects.toBeInstanceOf(DomainError);
        }
        expect(service.create).not.toHaveBeenCalled();
    });

    it('changes one with all its fields, and takes the id from the address only', async () => {
        const { controller, service } = setup();
        await controller.update('EU.EORI.IDP1', body({ name: 'New', server: 'https://new.example.org' }));
        expect(service.update).toHaveBeenCalledWith('EU.EORI.IDP1', { name: 'New', server: 'https://new.example.org' });
        await expect(controller.update('EU.EORI.IDP1', body({ ...valid }))).rejects.toBeInstanceOf(DomainError);
        await expect(
            controller.update('a/b', body({ name: 'x', server: 'https://x.example.org' }))
        ).rejects.toBeInstanceOf(DomainError);
    });

    it('removes one, and refuses an id that is not one', async () => {
        const { controller, service } = setup();
        await controller.remove('EU.EORI.IDP1');
        expect(service.remove).toHaveBeenCalledWith('EU.EORI.IDP1');
        await expect(controller.remove('$ne')).rejects.toBeInstanceOf(DomainError);
    });
});
