import { Readable } from 'node:stream';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BadGatewayError, DomainError } from '../common/domain-error';
import type { AppConfigService } from '../config/app-config.service';
import { FakeUpstream } from '../testing/fake-upstream';
import { FileServiceClient } from './file-service.client';

const service = new FakeUpstream();
let client: FileServiceClient;
const configFor = (url: string): AppConfigService =>
    ({
        fileService: { enabled: true, url, token: 'secret-token', timeoutMs: 5000, maxSizeMb: 100, acceptedTypes: '' }
    }) as unknown as AppConfigService;

const file = (text: string, chunks = 1) => ({
    stream: Readable.from(Array.from({ length: chunks }, () => Buffer.from(text))),
    filename: 'datos ñ.csv',
    mimeType: 'text/csv'
});

beforeAll(async () => {
    await service.start();
    client = new FileServiceClient(configFor(`http://127.0.0.1:${service.port}/`));
});
afterAll(() => service.stop());
beforeEach(() => {
    service.reset();
    service.answer((res) =>
        service.json(res, 200, JSON.stringify({ fileId: 'f-1', visibility: 'private', labels: { owner: 'p-ana' } }))
    );
});

describe('FileServiceClient', () => {
    it('uploads a file as a multipart body with its visibility and labels, with the token of the proxy', async () => {
        const stored = await client.upload('private', file('a,b\n', 3), { owner: 'p-ana' });

        expect(stored.fileId).toBe('f-1');
        expect(service.seen?.method).toBe('POST');
        expect(service.seen?.url).toBe('/api/files');
        expect(service.seen?.headers['authorization']).toBe('Bearer secret-token');
        expect(service.seen?.headers['content-type']).toMatch(/^multipart\/form-data; boundary=----bae-/);
        const body = service.seen?.body ?? '';
        expect(body).toContain('name="visibility"\r\n\r\nprivate\r\n');
        expect(body).toContain('name="labels"\r\n\r\n{"owner":"p-ana"}\r\n');
        expect(body).toContain('name="file"; filename="datos _.csv"; filename*=UTF-8\'\'datos%20%C3%B1.csv');
        expect(body).toContain('Content-Type: text/csv\r\n\r\na,b\na,b\na,b\n\r\n--');
    });

    it('does not send the labels when there are none, and replaces a file with a PUT', async () => {
        await client.upload('public', file('x'));
        expect(service.seen?.body).not.toContain('name="labels"');

        await client.replace('f/1', file('y'));
        expect(service.seen?.method).toBe('PUT');
        expect(service.seen?.url).toBe('/api/files/f%2F1');
    });

    it('adds labels, reads the metadata and finds a file or nothing', async () => {
        await client.addLabels('f-1', { resource: 'r-1' });
        expect(service.seen?.method).toBe('PATCH');
        expect(service.seen?.url).toBe('/api/files/f-1/labels');
        expect(JSON.parse(service.seen?.body ?? '')).toEqual({ labels: { resource: 'r-1' } });

        expect((await client.getMetadata('f-1')).labels).toEqual({ owner: 'p-ana' });
        expect(service.seen?.method).toBe('GET');

        service.answer((res) => service.json(res, 404, JSON.stringify({ message: 'no such file' })));
        expect(await client.find('f-2')).toBeUndefined();
        await expect(client.getMetadata('f-2')).rejects.toMatchObject({ status: 404, message: 'no such file' });
    });

    it('removes a file, and takes one that is not there as removed', async () => {
        service.answer((res) => {
            res.writeHead(204);
            res.end();
        });
        await client.remove('f-1');
        expect(service.seen?.method).toBe('DELETE');

        service.answer((res) => service.json(res, 404, '{}'));
        await expect(client.remove('f-2')).resolves.toBeUndefined();
    });

    it('gives the content as a stream, with the status and the headers of the file service and the range that was asked', async () => {
        service.answer((res) => {
            res.writeHead(206, { 'content-type': 'text/csv', 'content-range': 'bytes 0-3/10', etag: '"abc"' });
            res.end('a,b\n');
        });

        const content = await client.content('f-1', { range: 'bytes=0-3' });

        expect(content.status).toBe(206);
        expect(content.headers.get('content-range')).toBe('bytes 0-3/10');
        expect(service.seen?.headers['range']).toBe('bytes=0-3');
        expect(service.seen?.headers['accept-encoding']).not.toMatch(/gzip|deflate|br/);
        const chunks: Buffer[] = [];
        for await (const chunk of content.stream) {
            chunks.push(chunk as Buffer);
        }
        expect(Buffer.concat(chunks).toString()).toBe('a,b\n');
    });

    it("tells the client what is the client's fault, and a 502 for what is the file service's", async () => {
        service.answer((res) => service.json(res, 413, JSON.stringify({ message: 'too big' })));
        await expect(client.upload('private', file('x'))).rejects.toMatchObject({ status: 413, message: 'too big' });

        service.answer((res) => service.json(res, 500, JSON.stringify({ message: 'stack trace of the file service' })));
        const failure = await client.getMetadata('f-1').catch((error: unknown) => error as Error);
        expect(failure).toBeInstanceOf(BadGatewayError);
        expect((failure as Error).message).not.toContain('stack trace');
    });

    it('tells a 502 when the file service cannot be reached', async () => {
        const unreachable = new FileServiceClient(configFor('http://127.0.0.1:1'));
        await expect(unreachable.getMetadata('f-1')).rejects.toBeInstanceOf(BadGatewayError);
        await expect(unreachable.getMetadata('f-1')).rejects.toBeInstanceOf(DomainError);
    });
});
