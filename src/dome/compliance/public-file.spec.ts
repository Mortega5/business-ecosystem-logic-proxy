import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fetchPublicFile, isPublicAddress, PublicFileError } from './public-file';

const OPTIONS: { maxBytes: number, timeoutMs: number, origins: string[] } = {
    maxBytes: 1024,
    timeoutMs: 2000,
    origins: []
};

describe('isPublicAddress', () => {
    it('is true for addresses of the Internet', () => {
        for (const address of ['93.184.216.34', '8.8.8.8', '2606:4700:4700::1111']) {
            expect(isPublicAddress(address)).toBe(true);
        }
    });

    it('is false for private, loopback, link-local, shared and reserved ranges and for what is not an address', () => {
        for (const address of [
            '10.1.2.3',
            '172.16.0.1',
            '172.31.255.255',
            '192.168.1.1',
            '127.0.0.1',
            '169.254.169.254',
            '100.64.0.1',
            '0.0.0.0',
            '224.0.0.1',
            '255.255.255.255',
            '::1',
            '::',
            'fe80::1',
            'fc00::1',
            '::ffff:127.0.0.1',
            '::ffff:10.0.0.1',
            '64:ff9b::7f00:1',
            'example.org',
            ''
        ]) {
            expect(isPublicAddress(address), address).toBe(false);
        }
    });
});

describe('fetchPublicFile: what it refuses before it asks', () => {
    const refused = async (address: string, options = OPTIONS): Promise<PublicFileError> => {
        const error = (await fetchPublicFile(address, 0, options).catch((failure: unknown) => failure)) as PublicFileError;
        expect(error).toBeInstanceOf(PublicFileError);
        expect(error.kind).toBe('refused');
        return error;
    };

    it('refuses what is not an address, what is not http or https, and an address with credentials', async () => {
        await refused('not an address');
        await refused('file:///etc/passwd');
        await refused('ftp://files.example.org/a');
        await refused('gopher://files.example.org/');
        await refused('http://user:secret@files.example.org/a.pdf');
    });

    it('refuses an address that is a private or a loopback one', async () => {
        for (const address of [
            'http://127.0.0.1/a',
            'http://10.0.0.5/a',
            'http://169.254.169.254/latest/meta-data/',
            'http://[::1]/a',
            'http://[::ffff:7f00:1]/a',
            'http://0.0.0.0/a'
        ]) {
            await refused(address);
        }
    });

    it('refuses a name that is at a private address, when the connection is made', async () => {
        await refused('http://localhost/a');
    });

    it('refuses an origin that the configuration does not list', async () => {
        await refused('https://files.example.org/a.pdf', { ...OPTIONS, origins: ['https://other.example.org'] });
    });
});

describe('fetchPublicFile: even a server of this machine is not asked', () => {
    let server: Server;
    let port = 0;
    let asked = 0;

    beforeAll(async () => {
        server = createServer((_req, res) => {
            asked += 1;
            res.end('secret');
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        port = (server.address() as { port: number }).port;
    });
    afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

    it('does not connect to a service on the loopback, by address or by name', async () => {
        await expect(fetchPublicFile(`http://127.0.0.1:${port}/a`, 0, OPTIONS)).rejects.toMatchObject({
            kind: 'refused'
        });
        await expect(fetchPublicFile(`http://localhost:${port}/a`, 0, OPTIONS)).rejects.toMatchObject({
            kind: 'refused'
        });
        expect(asked).toBe(0);
    });
});
