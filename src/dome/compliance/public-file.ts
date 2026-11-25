import { lookup as resolve, type LookupAddress } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';

export type PublicFileFailure = 'refused' | 'too-large' | 'failed';

/** A file that could not be read from the address it was given; `kind` says why, the message is safe to tell the client. */
export class PublicFileError extends Error {
    constructor(
        message: string,
        readonly kind: PublicFileFailure
    ) {
        super(message);
        this.name = 'PublicFileError';
    }
}

export interface PublicFile {
    bytes: Buffer;
    contentType: string;
    filename: string;
}

export interface PublicFileOptions {
    maxBytes: number;
    timeoutMs: number;
    /** The origins the file may be at; none listed means any public address. */
    origins: string[];
}

// What is not the public Internet: private, loopback, link-local (the metadata of the cloud), shared, documentation and reserved ranges,
// and the ways to write an IPv4 address inside an IPv6 one
const NOT_PUBLIC = new BlockList();
for (const [network, bits] of [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4]
] as const) {
    NOT_PUBLIC.addSubnet(network, bits, 'ipv4');
}
for (const [network, bits] of [
    ['::', 128],
    ['::1', 128],
    ['::ffff:0:0', 96],
    ['64:ff9b::', 96],
    ['100::', 64],
    ['2001:db8::', 32],
    ['2002::', 16],
    ['fc00::', 7],
    ['fe80::', 10],
    ['ff00::', 8]
] as const) {
    NOT_PUBLIC.addSubnet(network, bits, 'ipv6');
}

export const isPublicAddress = (address: string): boolean => {
    const family = isIP(address);
    return family !== 0 && !NOT_PUBLIC.check(address, family === 4 ? 'ipv4' : 'ipv6');
};

// The check is made on the addresses the connection is made to, so a name that answers a public address to a check and a private one
// to the connection gets nowhere
const publicLookup: LookupFunction = (hostname, options, callback) => {
    resolve(hostname, { ...options, all: true }, (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => {
        if (error !== null) {
            callback(error, [], undefined);
            return;
        }
        if (addresses.length === 0 || !addresses.every((candidate) => isPublicAddress(candidate.address))) {
            callback(
                Object.assign(new Error('The address is not public'), { code: 'EBLOCKED' }) as NodeJS.ErrnoException,
                [],
                undefined
            );
            return;
        }
        if (options.all === true) {
            callback(null, addresses, undefined);
        } else {
            const [first] = addresses as [LookupAddress];
            callback(null, first.address, first.family);
        }
    });
};

const filenameOf = (url: URL, index: number): string => {
    let last = '';
    try {
        last = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() ?? '');
    } catch {
        // A name that does not decode is not used
    }
    const clean = last.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100);
    return clean === '' || /^\.+$/.test(clean) ? `compliance-file-${index + 1}` : clean;
};

/**
 * A file that is at an address the product names, which is whatever the seller wrote: only http and https, no credentials in the
 * address, only public addresses (checked when the connection is made), no redirects, a time to answer and a size that is not passed.
 */
export const fetchPublicFile = (address: string, index: number, options: PublicFileOptions): Promise<PublicFile> =>
    new Promise((resolveFile, reject) => {
        let url: URL;
        try {
            url = new URL(address);
        } catch {
            reject(new PublicFileError('is not an address', 'refused'));
            return;
        }
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
            reject(new PublicFileError('is not an http or https address', 'refused'));
            return;
        }
        if (url.username !== '' || url.password !== '') {
            reject(new PublicFileError('has credentials in its address', 'refused'));
            return;
        }
        if (options.origins.length > 0 && !options.origins.includes(url.origin)) {
            reject(new PublicFileError('is not at one of the origins allowed', 'refused'));
            return;
        }
        const host = url.hostname.replace(/^\[|\]$/g, '');
        if (isIP(host) !== 0 && !isPublicAddress(host)) {
            reject(new PublicFileError('is not at a public address', 'refused'));
            return;
        }

        const request = (url.protocol === 'https:' ? https : http).get(
            url,
            { lookup: publicLookup, headers: { accept: '*/*', 'accept-encoding': 'identity' } },
            (response) => {
                const status = response.statusCode ?? 0;
                if (status !== 200) {
                    response.resume();
                    reject(
                        status >= 300 && status < 400
                            ? new PublicFileError('is at an address that redirects', 'refused')
                            : new PublicFileError('could not be read', 'failed')
                    );
                    return;
                }
                const declared = Number(response.headers['content-length']);
                if (Number.isFinite(declared) && declared > options.maxBytes) {
                    response.resume();
                    reject(new PublicFileError('is too large', 'too-large'));
                    return;
                }
                const chunks: Buffer[] = [];
                let received = 0;
                response.on('data', (chunk: Buffer) => {
                    received += chunk.length;
                    if (received > options.maxBytes) {
                        reject(new PublicFileError('is too large', 'too-large'));
                        request.destroy();
                        return;
                    }
                    chunks.push(chunk);
                });
                response.on('end', () =>
                    resolveFile({
                        bytes: Buffer.concat(chunks),
                        contentType: String(response.headers['content-type'] ?? 'application/octet-stream').slice(
                            0,
                            200
                        ),
                        filename: filenameOf(url, index)
                    })
                );
                response.on('error', () => reject(new PublicFileError('could not be read', 'failed')));
            }
        );
        // One time for the whole of it, not only for the silence between two packets
        const timer = setTimeout(() => request.destroy(), options.timeoutMs);
        request.on('close', () => clearTimeout(timer));
        request.on('error', (error: NodeJS.ErrnoException) =>
            reject(
                error.code === 'EBLOCKED'
                    ? new PublicFileError('is not at a public address', 'refused')
                    : new PublicFileError('could not be read', 'failed')
            )
        );
    });
