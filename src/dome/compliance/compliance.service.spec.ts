import type { Request } from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BadGatewayError, DomainError, ForbiddenError, NotFoundError } from '../../common/domain-error';
import type { AppConfigService } from '../../config/app-config.service';
import { FakeUpstream } from '../../testing/fake-upstream';
import type { TmfProxy } from '../../tmf/tmf-proxy';
import { ComplianceService } from './compliance.service';
import { fetchPublicFile, PublicFileError } from './public-file';

vi.mock('./public-file', async (original) => ({
    ...(await original<typeof import('./public-file')>()),
    fetchPublicFile: vi.fn()
}));

const SPEC_ID = 'urn:ngsi-ld:product-specification:7a1c0f3e';
const spec = {
    id: SPEC_ID,
    name: 'Stored name',
    version: '1.2',
    relatedParty: [{ id: 'p-acme', role: 'Seller' }],
    productSpecCharacteristic: [
        { name: 'Compliance:ISO', productSpecCharacteristicValue: [{ value: 'https://files.example.org/iso.pdf' }] },
        { name: 'Compliance:VC', productSpecCharacteristicValue: [{ value: 'a.b.c' }] }
    ]
};
const organization = {
    tradingName: 'Acme',
    externalReference: [{ externalReferenceType: 'idm_id', name: 'VATES-1' }],
    partyCharacteristic: [{ name: 'country', value: 'ES' }]
};

const compliance = new FakeUpstream();
let answers: Record<string, { status: number, body: unknown }>;
const send = vi.fn(async (_req: Request, target: { upstream: string, path: string }) => {
    const answer = answers[`${target.upstream} ${target.path}`] ?? { status: 404, body: {} };
    return { status: answer.status, headers: new Headers(), body: JSON.stringify(answer.body) };
});

const settings = (extra: Record<string, unknown> = {}) => ({
    serverUrl: `http://127.0.0.1:${compliance.port}/`,
    timeoutMs: 3000,
    maxFiles: 2,
    maxFileMb: 1,
    fileOrigins: [],
    certifierRole: 'certifier',
    ...extra
});
const serviceWith = (dome: Record<string, unknown> = {}) =>
    new ComplianceService(
        { send } as unknown as TmfProxy,
        { auth: { roles: { seller: 'Seller' } }, dome: { compliance: settings(dome) } } as unknown as AppConfigService
    );
const as = (partyId: string | undefined, accessToken = 'user-token') =>
    ({ user: { partyId, accessToken } }) as unknown as Request;
const body = (id = SPEC_ID) =>
    JSON.stringify({ id, name: 'Name the client sent', relatedParty: [{ id: 'p-other', role: 'Seller' }] });

beforeAll(() => compliance.start());
afterAll(() => compliance.stop());
beforeEach(() => {
    send.mockClear();
    vi.mocked(fetchPublicFile).mockReset();
    vi.mocked(fetchPublicFile).mockResolvedValue({
        bytes: Buffer.from('pdf bytes'),
        contentType: 'application/pdf',
        filename: 'iso.pdf'
    });
    answers = {
        [`tmforum.catalog /productSpecification/${encodeURIComponent(SPEC_ID)}`]: { status: 200, body: spec },
        'tmforum.party /organization/p-acme': { status: 200, body: organization }
    };
    compliance.reset();
    compliance.answer((res) => compliance.json(res, 200, JSON.stringify({ certificate: 'issued' })));
});

describe('ComplianceService', () => {
    it('asks for the certificate with what TMForum has of the product, the seller and the files it names, and gives the answer of the service', async () => {
        const result = await serviceWith().requestCertificate(as('p-acme'), body());

        expect(result).toEqual({ status: 200, body: { certificate: 'issued' } });
        expect(compliance.seen?.method).toBe('POST');
        expect(compliance.seen?.url).toBe('/api/v1/product-offering/certificate');
        expect(compliance.seen?.headers['authorization']).toBe('Bearer user-token');
        const form = compliance.seen?.body ?? '';
        expect(form).toContain('name="product_specification_id"\r\n\r\n' + SPEC_ID);
        expect(form).toContain('name="service_name"\r\n\r\nStored name');
        expect(form).not.toContain('Name the client sent');
        expect(form).toContain('name="organization_name"\r\n\r\nAcme');
        expect(form).toContain('name="organization_country"\r\n\r\nES');
        expect(form).toContain('name="organization_vat_id"\r\n\r\nVATES-1');
        expect(form).toContain('name="requested_compliance_level"\r\n\r\nBaseline');
        expect(form).toContain('name="files"; filename="iso.pdf"');
        expect(vi.mocked(fetchPublicFile)).toHaveBeenCalledWith('https://files.example.org/iso.pdf', 0, {
            maxBytes: 1024 * 1024,
            timeoutMs: 3000,
            origins: []
        });
    });

    it('does not work without a compliance service, with a body that is not a product, or with an id that cannot be one', async () => {
        await expect(serviceWith({ serverUrl: '' }).requestCertificate(as('p-acme'), body())).rejects.toMatchObject({
            status: 503
        });
        await expect(serviceWith().requestCertificate(as('p-acme'), '{}')).rejects.toMatchObject({ status: 400 });
        await expect(serviceWith().requestCertificate(as('p-acme'), body('../../admin'))).rejects.toMatchObject({
            status: 400
        });
        expect(send).not.toHaveBeenCalled();
    });

    it('is only for the seller of the product, and for who has a party', async () => {
        await expect(serviceWith().requestCertificate(as('p-intruder'), body())).rejects.toBeInstanceOf(ForbiddenError);
        await expect(serviceWith().requestCertificate(as(undefined), body())).rejects.toBeInstanceOf(ForbiddenError);
        expect(compliance.seen).toBeUndefined();
    });

    it('answers 404 for a product or a seller organisation that TMForum does not have', async () => {
        answers = {};
        await expect(serviceWith().requestCertificate(as('p-acme'), body())).rejects.toBeInstanceOf(NotFoundError);
        answers = {
            [`tmforum.catalog /productSpecification/${encodeURIComponent(SPEC_ID)}`]: { status: 200, body: spec }
        };
        await expect(serviceWith().requestCertificate(as('p-acme'), body())).rejects.toBeInstanceOf(NotFoundError);
    });

    it('tells a 502 when TMForum fails', async () => {
        answers = {
            [`tmforum.catalog /productSpecification/${encodeURIComponent(SPEC_ID)}`]: {
                status: 500,
                body: { stack: 'secret' }
            }
        };
        await expect(serviceWith().requestCertificate(as('p-acme'), body())).rejects.toBeInstanceOf(BadGatewayError);
    });

    it('refuses a product that names more files than allowed, and tells which file cannot be used and why', async () => {
        const many = {
            ...spec,
            productSpecCharacteristic: [
                {
                    name: 'Compliance:A',
                    productSpecCharacteristicValue: ['x', 'y', 'z'].map((value) => ({
                        value: `https://f.example.org/${value}`
                    }))
                }
            ]
        };
        answers[`tmforum.catalog /productSpecification/${encodeURIComponent(SPEC_ID)}`] = { status: 200, body: many };
        await expect(serviceWith().requestCertificate(as('p-acme'), body())).rejects.toMatchObject({ status: 422 });

        answers[`tmforum.catalog /productSpecification/${encodeURIComponent(SPEC_ID)}`] = { status: 200, body: spec };
        vi.mocked(fetchPublicFile).mockRejectedValue(new PublicFileError('is not at a public address', 'refused'));
        await expect(serviceWith().requestCertificate(as('p-acme'), body())).rejects.toMatchObject({
            status: 422,
            message: 'The compliance file 1 is not at a public address'
        });
        vi.mocked(fetchPublicFile).mockRejectedValue(new PublicFileError('is too large', 'too-large'));
        await expect(serviceWith().requestCertificate(as('p-acme'), body())).rejects.toMatchObject({ status: 413 });
        vi.mocked(fetchPublicFile).mockRejectedValue(new PublicFileError('could not be read', 'failed'));
        await expect(serviceWith().requestCertificate(as('p-acme'), body())).rejects.toBeInstanceOf(BadGatewayError);
        expect(compliance.seen).toBeUndefined();
    });

    it("tells the client what the compliance service says when it is the client's fault, and a 502 for its own failures", async () => {
        compliance.answer((res) =>
            compliance.json(res, 422, JSON.stringify({ error: 'Missing organization email', trace: 'internal' }))
        );
        const refused = await serviceWith()
            .requestCertificate(as('p-acme'), body())
            .catch((error: unknown) => error as DomainError);
        expect(refused).toMatchObject({ status: 422, message: 'Missing organization email' });

        compliance.answer((res) => compliance.json(res, 500, JSON.stringify({ error: 'stack trace of the service' })));
        const failed = await serviceWith()
            .requestCertificate(as('p-acme'), body())
            .catch((error: unknown) => error as Error);
        expect(failed).toBeInstanceOf(BadGatewayError);
        expect((failed as Error).message).not.toContain('stack trace');
    });

    it('tells a 504 when the compliance service cannot be reached', async () => {
        await expect(
            serviceWith({ serverUrl: 'http://127.0.0.1:1' }).requestCertificate(as('p-acme'), body())
        ).rejects.toMatchObject({ status: 504 });
    });
});
