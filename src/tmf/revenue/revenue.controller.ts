import { All, Controller, Get, Param, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { NotFoundError } from '../../common/domain-error';
import { ResourceIdPipe } from '../resource-id.pipe';
import { TmfProxy } from '../tmf-proxy';

/**
 * The revenue sharing API, as far as the portal uses it: the dashboard of an organisation. Everything else under
 * /revenue is closed here, so it is not handed to the legacy application.
 */
@Controller('revenue')
export class RevenueController {
    constructor(private readonly proxy: TmfProxy) {}

    @Get('dashboard/:id')
    dashboard(@Param('id', ResourceIdPipe) id: string, @Req() req: Request, @Res() res: Response): Promise<void> {
        return this.proxy.forward(req, res, { upstream: 'revenue', path: `/dashboard/${encodeURIComponent(id)}` });
    }

    @All(['', '{*path}'])
    closed(): never {
        throw new NotFoundError('Not found');
    }
}
