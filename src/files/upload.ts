import busboy from 'busboy';
import type { IncomingMessage } from 'node:http';
import { PassThrough, type Readable } from 'node:stream';
import { DomainError } from '../common/domain-error';
import type { FileToUpload } from './file-service.client';

const FILE_FIELD = 'file';
const MAX_FIELD_BYTES = 100 * 1024;

export interface Upload {
    fields: Record<string, string>;
    /** The file, whose bytes are read as they arrive; null only when the file was optional and there is none. */
    file: FileToUpload | null;
}

export interface UploadOptions {
    fileOptional?: boolean;
    /** The largest file; a bigger one is refused with 413. */
    maxFileBytes?: number;
}

/**
 * Reads a multipart upload without keeping the file: the fields that come before it are read, and the file is given as a stream that
 * is fed while the rest of the body arrives. The file has to be the last part, and the only one. A refusal that comes once the file has
 * started ends its stream with the error.
 */
export const readUpload = (
    req: IncomingMessage,
    allowedFields: string[],
    options: UploadOptions = {}
): Promise<Upload> =>
    new Promise((resolve, reject) => {
        const limits: busboy.Limits = { fieldSize: MAX_FIELD_BYTES };
        if (options.maxFileBytes !== undefined && options.maxFileBytes > 0) {
            limits.fileSize = options.maxFileBytes;
        }
        let parser: busboy.Busboy;
        try {
            parser = busboy({ headers: req.headers, limits });
        } catch {
            req.resume();
            reject(new DomainError('The request must be multipart/form-data', 400));
            return;
        }

        const fields: Record<string, string> = {};
        let state: 'fields' | 'file' | 'done' | 'failed' = 'fields';
        const file = new PassThrough();
        file.on('error', () => undefined);
        let source: Readable | undefined;
        let fileEnded = false;
        let bodyEnded = false;

        const fail = (message: string, status = 400): void => {
            const error = new DomainError(message, status);
            if (state === 'fields') {
                reject(error);
            } else if (state === 'file') {
                if (source !== undefined) {
                    source.unpipe(file);
                    source.resume();
                }
                file.destroy(error);
            }
            state = 'failed';
        };
        // The stream of the file ends when the whole body has been read, not before: a body that breaks off is not a file
        const endFileWhenComplete = (): void => {
            if (state === 'file' && fileEnded && bodyEnded) {
                file.end();
            }
        };

        parser.on('field', (name, value, info) => {
            if (state === 'failed') {
                return;
            }
            if (state === 'file') {
                fail(`The field "${name}" must come before the file`);
            } else if (!allowedFields.includes(name)) {
                fail(`Unexpected field "${name}"`);
            } else if (name in fields) {
                fail(`The field "${name}" is repeated`);
            } else if (info.valueTruncated) {
                fail(`The field "${name}" is too long`);
            } else {
                fields[name] = value;
            }
        });

        parser.on('file', (name, stream, info) => {
            if (state !== 'fields') {
                stream.resume();
                if (state === 'file') {
                    fail('Only one file can be uploaded');
                }
                return;
            }
            if (name !== FILE_FIELD) {
                stream.resume();
                fail(`The file must be sent in the part "${FILE_FIELD}"`);
                return;
            }
            state = 'file';
            source = stream;
            stream.on('error', (error) => file.destroy(error));
            stream.on('limit', () => fail(`The file is larger than the ${options.maxFileBytes} bytes allowed`, 413));
            stream.on('end', () => {
                fileEnded = true;
                endFileWhenComplete();
            });
            stream.pipe(file, { end: false });
            resolve({ fields, file: { stream: file, filename: info.filename || FILE_FIELD, mimeType: info.mimeType } });
        });

        parser.on('error', (error: Error) => fail(`Malformed multipart body: ${error.message}`));
        parser.on('close', () => {
            bodyEnded = true;
            if (state === 'fields') {
                if (options.fileOptional === true) {
                    state = 'done';
                    resolve({ fields, file: null });
                } else {
                    fail(`The request has no part "${FILE_FIELD}"`);
                }
            }
            endFileWhenComplete();
        });
        req.on('aborted', () => fail('The client aborted the upload'));
        req.pipe(parser);
    });

/** Lets go of a file that is not going to be sent anywhere, so that the rest of the body is read and the request can be answered. */
export const discardFile = (file: FileToUpload): void => {
    file.stream.on('error', () => undefined);
    file.stream.resume();
};
