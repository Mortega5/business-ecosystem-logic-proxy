import { Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { BadGatewayError, DomainError } from '../common/domain-error';
import { AppConfigService } from '../config/app-config.service';

/** A file to upload: its bytes are read as they are sent, never kept. */
export interface FileToUpload {
    stream: Readable;
    filename: string;
    mimeType: string;
}

/** What the file service says of a file. The labels are the ones the proxy gave it. */
export interface StoredFile {
    fileId: string;
    url?: string;
    checksum?: string;
    size?: number;
    mimeType?: string;
    originalName?: string;
    visibility?: string;
    labels?: Record<string, unknown>;
}

export interface FileContent {
    status: number;
    headers: Headers;
    stream: Readable;
}

/** The error of the client that made the request fail, wherever the HTTP client has wrapped it. */
const causeOf = (error: unknown): DomainError | undefined => {
    for (let current = error, depth = 0; current instanceof Error && depth < 5; depth += 1) {
        if (current instanceof DomainError) {
            return current;
        }
        current = (current as { cause?: unknown }).cause;
    }
    return undefined;
};

// What the file service can tell a client that is its fault; anything else is the file service's, and the client is told it is a 502
const CLIENT_STATUSES = [400, 404, 409, 413, 415, 416, 422];

const quote = (value: string): string => value.replace(/["\\\r\n]/g, '_');
const encodeExtendedValue = (value: string): string => encodeURIComponent(value).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);

/** The multipart body of an upload, as a stream: the fields first and then the file, which is not read until it is sent. */
const multipartBody = (boundary: string, fields: Record<string, string>, file: FileToUpload): Readable =>
    Readable.from(
        (async function* () {
            for (const [name, value] of Object.entries(fields)) {
                yield Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${quote(name)}"\r\n\r\n${value}\r\n`);
            }
            const asciiName = quote(file.filename).replace(/[^\x20-\x7e]/g, '_');
            yield Buffer.from(
                `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${asciiName}"; filename*=UTF-8''${encodeExtendedValue(file.filename)}\r\n` +
                    `Content-Type: ${quote(file.mimeType)}\r\n\r\n`
            );
            for await (const chunk of file.stream) {
                yield chunk as Buffer;
            }
            yield Buffer.from(`\r\n--${boundary}--\r\n`);
        })()
    );

/**
 * The file service, which keeps the files of the datasets. It is called with the token of the proxy, and what it answers is told to
 * the client only when it is the client's fault. Files are streamed in both directions.
 */
@Injectable()
export class FileServiceClient {
    private readonly logger = new Logger(FileServiceClient.name);

    constructor(private readonly config: AppConfigService) {}

    upload(visibility: string, file: FileToUpload, labels?: Record<string, string>): Promise<StoredFile> {
        const fields: Record<string, string> = { visibility };
        if (labels !== undefined && Object.keys(labels).length > 0) {
            fields['labels'] = JSON.stringify(labels);
        }
        return this.sendFile('POST', '/api/files', fields, file);
    }

    replace(fileId: string, file: FileToUpload): Promise<StoredFile> {
        return this.sendFile('PUT', this.pathOf(fileId), {}, file);
    }

    addLabels(fileId: string, labels: Record<string, string>): Promise<StoredFile> {
        return this.json('PATCH', `${this.pathOf(fileId)}/labels`, { labels });
    }

    getMetadata(fileId: string): Promise<StoredFile> {
        return this.json('GET', this.pathOf(fileId));
    }

    /** The file, or undefined when the file service does not have it. */
    async find(fileId: string): Promise<StoredFile | undefined> {
        try {
            return await this.getMetadata(fileId);
        } catch (error) {
            if (error instanceof DomainError && error.status === 404) {
                return undefined;
            }
            throw error;
        }
    }

    /** Removes the file; one that is not there is as removed. */
    async remove(fileId: string): Promise<void> {
        try {
            await this.request('DELETE', this.pathOf(fileId), {});
        } catch (error) {
            if (!(error instanceof DomainError && error.status === 404)) {
                throw error;
            }
        }
    }

    /** The bytes of the file as the file service sends them, for the client to be given as they come. */
    async content(fileId: string, headers: Record<string, string>): Promise<FileContent> {
        // Not compressed, so that the length and the ranges the client is told are the ones of the bytes it gets
        const response = await this.request('GET', `${this.pathOf(fileId)}/content`, { ...headers, 'accept-encoding': 'identity' });
        return {
            status: response.status,
            headers: response.headers,
            stream: response.body === null ? Readable.from([]) : Readable.fromWeb(response.body as never)
        };
    }

    private pathOf(fileId: string): string {
        return `/api/files/${encodeURIComponent(fileId)}`;
    }

    private async sendFile(method: string, path: string, fields: Record<string, string>, file: FileToUpload): Promise<StoredFile> {
        const boundary = `----bae-${randomBytes(12).toString('hex')}`;
        const response = await this.request(
            method,
            path,
            { 'content-type': `multipart/form-data; boundary=${boundary}` },
            Readable.toWeb(multipartBody(boundary, fields, file)) as ReadableStream
        );
        return (await response.json()) as StoredFile;
    }

    private async json(method: string, path: string, body?: unknown): Promise<StoredFile> {
        const response = await this.request(
            method,
            path,
            body === undefined ? {} : { 'content-type': 'application/json' },
            body === undefined ? undefined : JSON.stringify(body)
        );
        return (await response.json()) as StoredFile;
    }

    private async request(method: string, path: string, headers: Record<string, string>, body?: BodyInit): Promise<Response> {
        const { url, token, timeoutMs } = this.config.fileService;
        let response: Response;
        try {
            response = await fetch(`${url.replace(/\/+$/, '')}${path}`, {
                method,
                headers: { accept: 'application/json', ...headers, ...(token === undefined || token === '' ? {} : { authorization: `Bearer ${token}` }) },
                signal: AbortSignal.timeout(timeoutMs),
                ...(body === undefined ? {} : { body, duplex: 'half' })
            } as RequestInit);
        } catch (error) {
            // An upload that the client broke (a file that is too big, a body that was cut) fails here with its own error: it is the
            // client's, and it is told as it is
            const own = causeOf(error);
            if (own !== undefined) {
                throw own;
            }
            this.logger.error({ method, path, err: error }, 'The file service could not be reached');
            throw new BadGatewayError('The file service is not reachable');
        }
        if (response.status < 400) {
            return response;
        }
        const message = await this.messageOf(response);
        if (CLIENT_STATUSES.includes(response.status)) {
            throw new DomainError(message ?? `The file service answered ${response.status}`, response.status);
        }
        this.logger.error({ method, path, statusCode: response.status, ...(message === undefined ? {} : { upstreamError: message }) }, 'The file service failed');
        throw new BadGatewayError(`The file service answered ${response.status}`);
    }

    // What the file service says is for the client only when it is the client's fault
    private async messageOf(response: Response): Promise<string | undefined> {
        try {
            const body = (await response.json()) as { message?: unknown };
            return typeof body.message === 'string' && body.message !== '' ? body.message : undefined;
        } catch {
            return undefined;
        }
    }
}
