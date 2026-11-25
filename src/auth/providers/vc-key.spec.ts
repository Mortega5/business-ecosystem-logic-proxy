import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import jwt from 'jsonwebtoken';
import { describe, expect, it } from 'vitest';
import { proxyKeyHex, proxyKeys } from './fake-vc-verifier';
import { loadVcPrivateKey } from './vc-key';

const signedBy = (key: ReturnType<typeof loadVcPrivateKey>): string =>
    jwt.sign({ iss: 'bae' }, key, { algorithm: 'ES256' });

describe('loadVcPrivateKey', () => {
    it('builds the key of the curve P-256 from its 32 bytes in hexadecimal, so that what it signs is checked by its public key', () => {
        const token = signedBy(loadVcPrivateKey({ hex: proxyKeyHex() }));
        expect(jwt.verify(token, proxyKeys.publicKey, { algorithms: ['ES256'] })).toMatchObject({ iss: 'bae' });
    });

    it('takes a key that starts with zeros and so is shorter in hexadecimal', () => {
        expect(() => loadVcPrivateKey({ hex: '1'.padStart(10, '0').replace(/^0+/, '') })).not.toThrow();
    });

    it('reads a PEM file, which wins over the hexadecimal key', () => {
        const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
        const file = join(mkdtempSync(join(tmpdir(), 'bae-vc-')), 'key.pem');
        writeFileSync(file, privateKey.export({ format: 'pem', type: 'pkcs8' }));
        const token = signedBy(loadVcPrivateKey({ file, hex: proxyKeyHex() }));
        expect(jwt.verify(token, publicKey, { algorithms: ['ES256'] })).toMatchObject({ iss: 'bae' });
    });

    it('refuses what is not a key, and a file that cannot be read', () => {
        expect(() => loadVcPrivateKey({})).toThrow('32 bytes');
        expect(() => loadVcPrivateKey({ hex: 'not hexadecimal' })).toThrow('32 bytes');
        expect(() => loadVcPrivateKey({ hex: 'a'.repeat(65) })).toThrow('32 bytes');
        expect(() => loadVcPrivateKey({ file: join(tmpdir(), 'bae-no-such-key.pem') })).toThrow('ENOENT');
    });
});
