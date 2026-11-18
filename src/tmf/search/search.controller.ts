import { All, Body, Controller, Get, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { NotFoundError } from '../../common/domain-error';
import { JsonBodyPipe } from '../json-body.pipe';
import { TmfProxy } from '../tmf-proxy';

/**
 * The organisation search, as far as the portal uses it: the search itself and the lists of values it filters by.
 * Everything else under /search-bck is closed here, so it is not handed to the legacy application.
 */
@Controller('search-bck')
export class SearchController {
    constructor(private readonly proxy: TmfProxy) {}

    @Post('api/searchOrganizations')
    search(@Body(JsonBodyPipe) body: string, @Req() req: Request, @Res() res: Response): Promise<void> {
        return this.proxy.forward(req, res, { upstream: 'search', path: '/api/searchOrganizations', body });
    }

    @Get('api/categories')
    categories(@Req() req: Request, @Res() res: Response): Promise<void> {
        return this.proxy.forward(req, res, { upstream: 'search', path: '/api/categories' });
    }

    @Get('api/countries')
    countries(@Req() req: Request, @Res() res: Response): Promise<void> {
        return this.proxy.forward(req, res, { upstream: 'search', path: '/api/countries' });
    }

    @Get('api/complianceLevels')
    complianceLevels(@Req() req: Request, @Res() res: Response): Promise<void> {
        return this.proxy.forward(req, res, { upstream: 'search', path: '/api/complianceLevels' });
    }

    @All(['', '{*path}'])
    closed(): never {
        throw new NotFoundError('Not found');
    }
}
