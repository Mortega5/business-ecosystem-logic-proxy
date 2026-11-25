import { createECDH, createPrivateKey, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';

/**
 * The private key with which the proxy signs for the verifier: a PEM file, or else the 32 bytes of an EC key of the curve P-256 in
 * hexadecimal, which is what the wallets of the platform hand out. It is read when the proxy starts, so that a key that cannot be read
 * stops it and does not fail the first login.
 */
export const loadVcPrivateKey = (source: { file?: string, hex?: string }): KeyObject => {
    if (source.file !== undefined) {
        return createPrivateKey({ key: readFileSync(source.file, 'utf8'), format: 'pem' });
    }
    if (source.hex === undefined || !/^[0-9a-fA-F]{1,64}$/.test(source.hex)) {
        throw new Error('The private key of the verifier login has to be 32 bytes in hexadecimal, or a PEM file');
    }
    const secret = Buffer.from(source.hex.padStart(64, '0'), 'hex');
    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(secret);
    const point = ecdh.getPublicKey();
    return createPrivateKey({
        format: 'jwk',
        key: {
            kty: 'EC',
            crv: 'P-256',
            d: secret.toString('base64url'),
            x: point.subarray(1, 33).toString('base64url'),
            y: point.subarray(33, 65).toString('base64url')
        }
    });
};
