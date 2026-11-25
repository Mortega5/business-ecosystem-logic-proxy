import { All, Controller, Get, Param, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { NotFoundError } from '../../common/domain-error';
import { OwnedResources } from '../owned-resources';
import { ResourceIdPipe } from '../resource-id.pipe';

/**
 * The resource inventory, as far as the portal uses it: the list of what the caller is related to as a customer and one
 * resource of it. Everything else under /resourceInventory, a write included, is closed.
 */
@Controller('resourceInventory')
export class ResourceInventoryController {
    constructor(private readonly owned: OwnedResources) {}

    @Get('resource')
    list(@Req() req: Request, @Res() res: Response): Promise<void> {
        return this.owned.list(req, res, { upstream: 'tmforum.resourceInventory', path: '/resource' });
    }

    @Get('resource/:id')
    read(@Param('id', ResourceIdPipe) id: string, @Req() req: Request, @Res() res: Response): Promise<void> {
        return this.owned.read(req, res, { upstream: 'tmforum.resourceInventory', path: `/resource/${encodeURIComponent(id)}`, noun: 'resource' });
    }

    @All(['', '{*path}'])
    closed(): never {
        throw new NotFoundError('Not found');
    }
}
