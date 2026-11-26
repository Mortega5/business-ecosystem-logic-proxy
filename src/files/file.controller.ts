import { All, Controller, Delete, Get, HttpCode, Logger, Param, Post, Put, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { pipeline } from 'node:stream/promises';
import { DomainError, ForbiddenError, NotFoundError } from '../common/domain-error';
import { AppConfigService } from '../config/app-config.service';
import { RequireFeature } from '../features/require-feature';
import type { UpstreamUser } from '../tmf/upstream-headers';
import { OWNER_LABEL, ownerOf } from './file-guards';
import { FileServiceClient, type StoredFile } from './file-service.client';
import { discardFile, readUpload } from './upload';

const VISIBILITIES = ['private', 'public'];
// A file id is what the file service makes: letters, digits and a few signs. Anything else is a file that cannot exist
const FILE_ID = /^[A-Za-z0-9._-]{1,128}$/;
const FORWARDED_REQUEST_HEADERS = ['range', 'if-range', 'if-none-match'];
const FORWARDED_RESPONSE_HEADERS = [
    'content-type',
    'content-length',
    'content-range',
    'content-disposition',
    'accept-ranges',
    'etag',
    'repr-digest',
    'last-modified',
    'cache-control',
    'x-content-type-options'
];

interface FileView {
    fileId: string;
    url?: string;
    checksum?: string;
    size?: number;
    mimeType?: string;
    originalName?: string;
    visibility?: string;
}

// What the client is told of a file: the labels are the proxy's own
const viewOf = (file: StoredFile): FileView => ({
    fileId: file.fileId,
    ...(file.url === undefined ? {} : { url: file.url }),
    ...(file.checksum === undefined ? {} : { checksum: file.checksum }),
    ...(file.size === undefined ? {} : { size: file.size }),
    ...(file.mimeType === undefined ? {} : { mimeType: file.mimeType }),
    ...(file.originalName === undefined ? {} : { originalName: file.originalName }),
    ...(file.visibility === undefined ? {} : { visibility: file.visibility })
});

/**
 * The files of the datasets, kept in the file service behind the party that uploaded them. Only a seller manages files, and only
 * their own: a file of another party is as if it did not exist. Bodies are streamed, never read whole.
 */
@RequireFeature('datasets')
@Controller('file')
export class FileController {
    private readonly logger = new Logger(FileController.name);

    constructor(
        private readonly files: FileServiceClient,
        private readonly config: AppConfigService
    ) {}

    @Post()
    @HttpCode(201)
    async create(@Req() req: Request): Promise<FileView> {
        return this.draining(req, async () => {
            const user = this.seller(req);
            const upload = await readUpload(req, ['visibility'], { maxFileBytes: this.maxBytes() });
            // `readUpload` resolves with a file when it has started, so there is one
            const file = upload.file as NonNullable<typeof upload.file>;
            const visibility = upload.fields['visibility'] ?? 'private';
            if (!VISIBILITIES.includes(visibility)) {
                discardFile(file);
                throw new DomainError(`The visibility of a file must be one of: ${VISIBILITIES.join(', ')}`, 422);
            }
            return viewOf(await this.files.upload(visibility, file, { [OWNER_LABEL]: this.partyOf(user) }));
        });
    }

    @Get(':id')
    async get(@Param('id') id: string, @Req() req: Request): Promise<FileView> {
        return viewOf(await this.owned(this.seller(req), id));
    }

    @Get(':id/content')
    async content(@Param('id') id: string, @Req() req: Request, @Res() res: Response): Promise<void> {
        const metadata = await this.owned(this.seller(req), id);
        const requested: Record<string, string> = {};
        for (const name of FORWARDED_REQUEST_HEADERS) {
            const value = req.headers[name];
            if (typeof value === 'string' && value !== '') {
                requested[name] = value;
            }
        }
        const answer = await this.files.content(metadata.fileId, requested);
        res.status(answer.status);
        for (const name of FORWARDED_RESPONSE_HEADERS) {
            const value = answer.headers.get(name);
            if (value !== null) {
                res.setHeader(name, value);
            }
        }
        if (answer.status === 304) {
            answer.stream.destroy();
            res.end();
            return;
        }
        try {
            await pipeline(answer.stream, res);
        } catch (error) {
            // The status and the first bytes are already sent: all that is left is to cut the connection
            this.logger.warn({ fileId: metadata.fileId, err: error }, 'The download of a file was interrupted');
            res.destroy();
        }
    }

    @Put(':id')
    @HttpCode(200)
    async replace(@Param('id') id: string, @Req() req: Request): Promise<FileView> {
        return this.draining(req, async () => {
            const metadata = await this.owned(this.seller(req), id);
            const upload = await readUpload(req, [], { maxFileBytes: this.maxBytes() });
            return viewOf(await this.files.replace(metadata.fileId, upload.file as NonNullable<typeof upload.file>));
        });
    }

    @Delete(':id')
    @HttpCode(204)
    async remove(@Param('id') id: string, @Req() req: Request): Promise<void> {
        const metadata = await this.owned(this.seller(req), id);
        await this.files.remove(metadata.fileId);
    }

    // Nothing else is under /file
    @All(['', '{*path}'])
    closed(): never {
        throw new NotFoundError('Not found');
    }

    private maxBytes(): number {
        return this.config.fileService.maxSizeMb * 1024 * 1024;
    }

    /** The user, who has to be a seller, when the file service is there. */
    private seller(req: Request): UpstreamUser {
        if (!this.config.fileService.enabled) {
            throw new NotFoundError('Files are not enabled in this marketplace');
        }
        const user = (req as Request & { user: UpstreamUser }).user;
        const seller = this.config.auth.roles.seller.toLowerCase();
        if (!(user.roles ?? []).some((role) => role.name.toLowerCase() === seller)) {
            throw new ForbiddenError('You need the seller role to manage files');
        }
        return user;
    }

    private partyOf(user: UpstreamUser): string {
        if (user.partyId === undefined || user.partyId === null || user.partyId === '') {
            throw new ForbiddenError('You need a party to manage files');
        }
        return user.partyId;
    }

    /** The file, when it is the user's; one of another party is the same as one that does not exist. */
    private async owned(user: UpstreamUser, id: string): Promise<StoredFile> {
        if (!FILE_ID.test(id)) {
            throw new NotFoundError('The file does not exist');
        }
        const file = await this.files.find(id);
        if (file === undefined || ownerOf(file) !== this.partyOf(user)) {
            throw new NotFoundError('The file does not exist');
        }
        return file;
    }

    // A refusal before the body has been read is answered after it has: the client is not left sending to nobody
    private async draining<T>(req: Request, work: () => Promise<T>): Promise<T> {
        try {
            return await work();
        } catch (error) {
            if (!req.readableEnded) {
                req.resume();
            }
            throw error;
        }
    }
}
