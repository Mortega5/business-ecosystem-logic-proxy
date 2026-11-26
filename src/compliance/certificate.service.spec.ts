import jwt from 'jsonwebtoken';
import type { Request } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadGatewayError, ForbiddenError, NotFoundError } from '../common/domain-error';
import type { AppConfigService } from '../config/app-config.service';
import type { TmfProxy } from '../tmf/tmf-proxy';
import { CertificateService } from './certificate.service';

const SPEC_ID = 'urn:ngsi-ld:product-specification:7a1c0f3e';
const credential = jwt.sign({ vc: { credentialSubject: {} } }, 'secret');

let current: { status: number, body: unknown };
let updated: { status: number, body: unknown };
const send = vi.fn(async (_req: Request, target: { method?: string }) => {
    const answer = target.method === 'PATCH' ? updated : current;
    return { status: answer.status, headers: new Headers(), body: JSON.stringify(answer.body) };
});
const service = new CertificateService(
    { send } as unknown as TmfProxy,
    {
        auth: { roles: { admin: 'admin', certifier: 'certifier' } }
    } as unknown as AppConfigService
);

const as = (user: object | undefined) => ({ user }) as unknown as Request;
const admin = { id: 'u-root', roles: [{ name: 'admin' }] };
const body = (vc: unknown = credential) => JSON.stringify({ vc });

beforeEach(() => {
    send.mockClear();
    current = {
        status: 200,
        body: {
            id: SPEC_ID,
            productSpecCharacteristic: [{ name: 'Other', productSpecCharacteristicValue: [{ value: 'x' }] }]
        }
    };
    updated = { status: 200, body: {} };
});

describe('CertificateService: who may upload a credential', () => {
    it('lets an administrator, a certifier and a member of an organisation that is a certifier', async () => {
        await service.upload(as(admin), SPEC_ID, body());
        await service.upload(as({ id: 'u-1', roles: [{ name: 'Certifier' }] }), SPEC_ID, body());
        await service.upload(
            as({
                id: 'u-2',
                roles: [{ name: 'Buyer' }],
                organizations: [{ id: 'o', name: 'O', roles: [{ name: 'certifier' }] }]
            }),
            SPEC_ID,
            body()
        );
        expect(send.mock.calls.filter(([, target]) => target.method === 'PATCH')).toHaveLength(3);
    });

    it('refuses a seller, a buyer and a request with nobody, without asking the catalog', async () => {
        for (const user of [
            { id: 'u-3', roles: [{ name: 'Seller' }] },
            { id: 'u-4', roles: [] },
            {
                id: 'u-5',
                roles: [{ name: 'Buyer' }],
                organizations: [{ id: 'o', name: 'O', roles: [{ name: 'orgAdmin' }] }]
            },
            undefined
        ]) {
            await expect(service.upload(as(user), SPEC_ID, body())).rejects.toBeInstanceOf(ForbiddenError);
        }
        expect(send).not.toHaveBeenCalled();
    });
});

describe('CertificateService: the credential', () => {
    it('puts it in the product as the characteristic Compliance:VC, and keeps the others', async () => {
        await service.upload(as(admin), SPEC_ID, body());

        const [, patch] = send.mock.calls.find(([, target]) => target.method === 'PATCH') as [
            Request,
            { path: string, body: string, contentType: string }
        ];
        expect(patch.path).toBe(`/productSpecification/${encodeURIComponent(SPEC_ID)}`);
        expect(patch.contentType).toBe('application/json');
        const { productSpecCharacteristic } = JSON.parse(patch.body) as {
            productSpecCharacteristic: { name: string, id?: string, productSpecCharacteristicValue: unknown[] }[]
        };
        expect(productSpecCharacteristic.map((characteristic) => characteristic.name)).toEqual([
            'Other',
            'Compliance:VC'
        ]);
        expect(productSpecCharacteristic[1]?.id).toMatch(/^urn:ngsi-ld:characteristic:/);
        expect(productSpecCharacteristic[1]?.productSpecCharacteristicValue).toEqual([
            { isDefault: true, value: credential }
        ]);
    });

    it('replaces the credential that the product had, whatever the case of its name', async () => {
        current = {
            status: 200,
            body: {
                id: SPEC_ID,
                productSpecCharacteristic: [
                    { name: 'compliance:vc', productSpecCharacteristicValue: [{ value: 'old' }] },
                    { name: 'Other', productSpecCharacteristicValue: [] }
                ]
            }
        };
        await service.upload(as(admin), SPEC_ID, body());
        const patch = send.mock.calls.find(([, target]) => target.method === 'PATCH')?.[1] as unknown as {
            body: string
        };
        const names = (
            JSON.parse(patch.body) as { productSpecCharacteristic: { name: string }[] }
        ).productSpecCharacteristic.map((characteristic) => characteristic.name);
        expect(names).toEqual(['Other', 'Compliance:VC']);
    });

    it('refuses a body with no credential, one that is not text, one that is not a signed token and one that is too big', async () => {
        await expect(service.upload(as(admin), SPEC_ID, '{}')).rejects.toMatchObject({
            status: 400,
            message: 'Missing VC'
        });
        await expect(service.upload(as(admin), SPEC_ID, body(42))).rejects.toMatchObject({ status: 400 });
        await expect(service.upload(as(admin), SPEC_ID, body('not a token'))).rejects.toMatchObject({ status: 422 });
        await expect(service.upload(as(admin), SPEC_ID, body('a'.repeat(70 * 1024)))).rejects.toMatchObject({
            status: 400
        });
        expect(send).not.toHaveBeenCalled();
    });
});

describe('CertificateService: the product', () => {
    it('answers 404 for a product that is not there', async () => {
        current = { status: 404, body: {} };
        await expect(service.upload(as(admin), SPEC_ID, body())).rejects.toBeInstanceOf(NotFoundError);
    });

    it('tells a 502 when the catalog fails to give the product or to take the credential', async () => {
        current = { status: 500, body: {} };
        await expect(service.upload(as(admin), SPEC_ID, body())).rejects.toBeInstanceOf(BadGatewayError);
        current = { status: 200, body: { id: SPEC_ID } };
        updated = { status: 422, body: { error: 'detail of the catalog' } };
        const failure = await service.upload(as(admin), SPEC_ID, body()).catch((error: unknown) => error as Error);
        expect(failure).toBeInstanceOf(BadGatewayError);
        expect((failure as Error).message).not.toContain('detail');
    });
});
