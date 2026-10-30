import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface SelfSignedCertificate {
    keyFile: string;
    certFile: string;
    cert: Buffer;
}

/** A throwaway certificate for localhost, generated with the openssl command line. */
export const createSelfSignedCertificate = (): SelfSignedCertificate => {
    const dir = mkdtempSync(join(tmpdir(), 'bae-tls-'));
    const keyFile = join(dir, 'key.pem');
    const certFile = join(dir, 'cert.pem');
    execFileSync(
        'openssl',
        ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', certFile, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'],
        { stdio: 'ignore' }
    );
    return { keyFile, certFile, cert: readFileSync(certFile) };
};
