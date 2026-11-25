import { All, Controller, Get, Param, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { NotFoundError } from '../../common/domain-error';
import { OwnedResources } from '../owned-resources';
import { ResourceIdPipe } from '../resource-id.pipe';

/**
 * The service inventory, as far as the portal uses it: the list of what the caller is related to as a customer and one
 * service of it. Everything else under /serviceInventory, a write included, is closed.
 */
@Controller('serviceInventory')
export class ServiceInventoryController {
    constructor(private readonly owned: OwnedResources) {}

    @Get('service')
    list(@Req() req: Request, @Res() res: Response): Promise<void> {
        return this.owned.list(req, res, { upstream: 'tmforum.serviceInventory', path: '/service' });
    }

    @Get('service/:id')
    read(@Param('id', ResourceIdPipe) id: string, @Req() req: Request, @Res() res: Response): Promise<void> {
        return this.owned.read(req, res, { upstream: 'tmforum.serviceInventory', path: `/service/${encodeURIComponent(id)}`, noun: 'service' });
    }

    @All(['', '{*path}'])
    closed(): never {
        throw new NotFoundError('Not found');
    }
}
