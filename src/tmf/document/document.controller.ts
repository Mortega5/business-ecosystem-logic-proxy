import { All, Controller, Get, Param, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { NotFoundError } from '../../common/domain-error';
import { ResourceIdPipe } from '../resource-id.pipe';
import { TmfProxy } from '../tmf-proxy';

/**
 * The document API, as far as the portal uses it: it reads a document specification (the content of an attachment).
 * Everything else under /document is closed here.
 */
@Controller('document')
export class DocumentController {
    constructor(private readonly proxy: TmfProxy) {}

    @Get('documentSpecification/:id')
    read(@Param('id', ResourceIdPipe) id: string, @Req() req: Request, @Res() res: Response): Promise<void> {
        return this.proxy.forward(req, res, {
            upstream: 'tmforum.document',
            path: `/documentSpecification/${encodeURIComponent(id)}`
        });
    }

    @All(['', '{*path}'])
    closed(): never {
        throw new NotFoundError('Not found');
    }
}
