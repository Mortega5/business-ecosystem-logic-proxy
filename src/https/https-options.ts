import { constants } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { HttpsOptions } from '@nestjs/common/interfaces/external/https-options.interface';
import type { AppConfig } from '../config/config.schema';

const CIPHERS = [
    'ECDHE-RSA-AES256-SHA384',
    'DHE-RSA-AES256-SHA384',
    'ECDHE-RSA-AES256-SHA256',
    'DHE-RSA-AES256-SHA256',
    'ECDHE-RSA-AES128-SHA256',
    'DHE-RSA-AES128-SHA256',
    'HIGH',
    '!aNULL',
    '!eNULL',
    '!EXPORT',
    '!DES',
    '!RC4',
    '!MD5',
    '!PSK',
    '!SRP',
    '!CAMELLIA'
].join(':');

const read = (path: string): Buffer => {
    try {
        return readFileSync(path);
    } catch (error) {
        throw new Error(`Cannot read the TLS file ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
};

/** TLS settings for the HTTP server, or undefined when HTTPS is not enabled. */
export const buildHttpsOptions = (https: AppConfig['app']['https']): HttpsOptions | undefined => {
    if (!https.enabled || https.keyFile === undefined || https.certFile === undefined) {
        return undefined;
    }
    return {
        key: read(https.keyFile),
        cert: read(https.certFile),
        ...(https.caFile === undefined ? {} : { ca: read(https.caFile) }),
        secureOptions: constants.SSL_OP_NO_TLSv1 | constants.SSL_OP_NO_TLSv1_1,
        ciphers: CIPHERS,
        honorCipherOrder: true
    };
};
