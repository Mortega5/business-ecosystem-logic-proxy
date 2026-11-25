import { All, Controller, Get, Param, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { NotFoundError } from '../../common/domain-error';
import { OwnedResources } from '../owned-resources';
import { ResourceIdPipe } from '../resource-id.pipe';

/**
 * The product inventory, as far as the portal uses it: the list of what the caller is related to as a customer and one
 * product of it. Everything else under /inventory, a write included, is closed.
 */
@Controller('inventory')
export class InventoryController {
    constructor(private readonly owned: OwnedResources) {}

    @Get('product')
    list(@Req() req: Request, @Res() res: Response): Promise<void> {
        return this.owned.list(req, res, { upstream: 'tmforum.inventory', path: '/product' });
    }

    @Get('product/:id')
    read(@Param('id', ResourceIdPipe) id: string, @Req() req: Request, @Res() res: Response): Promise<void> {
        return this.owned.read(req, res, { upstream: 'tmforum.inventory', path: `/product/${encodeURIComponent(id)}`, noun: 'product' });
    }

    @All(['', '{*path}'])
    closed(): never {
        throw new NotFoundError('Not found');
    }
}
