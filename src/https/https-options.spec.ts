import { constants } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createSelfSignedCertificate } from '../testing/self-signed-certificate';
import { buildHttpsOptions } from './https-options';

describe('buildHttpsOptions', () => {
    const { keyFile, certFile, cert } = createSelfSignedCertificate();

    it('returns nothing while HTTPS is disabled, even with files configured', () => {
        expect(buildHttpsOptions({ enabled: false })).toBeUndefined();
        expect(buildHttpsOptions({ enabled: false, keyFile, certFile })).toBeUndefined();
    });

    it('reads the key and the certificate and restricts the protocols and ciphers', () => {
        const options = buildHttpsOptions({ enabled: true, keyFile, certFile });

        expect(options?.cert).toEqual(cert);
        expect(Buffer.isBuffer(options?.key)).toBe(true);
        expect(options).not.toHaveProperty('ca');
        expect(options?.honorCipherOrder).toBe(true);
        expect(options?.ciphers).toContain('ECDHE-RSA-AES256-SHA384');
        expect(options?.ciphers).toContain('!RC4');
        expect((options?.secureOptions ?? 0) & constants.SSL_OP_NO_TLSv1_1).toBeGreaterThan(0);
    });

    it('adds the certificate authority when there is one', () => {
        expect(buildHttpsOptions({ enabled: true, keyFile, certFile, caFile: certFile })?.ca).toEqual(cert);
    });

    it('names the file it cannot read', () => {
        expect(() => buildHttpsOptions({ enabled: true, keyFile: '/missing/key.pem', certFile })).toThrow(
            'Cannot read the TLS file /missing/key.pem'
        );
    });
});
