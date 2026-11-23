import { All, Body, Controller, Get, Param, Patch, Post, Req, Res, UseInterceptors } from '@nestjs/common';
import type { Request, Response } from 'express';
import { NotFoundError } from '../../common/domain-error';
import { BodyTextInterceptor } from '../body-text.interceptor';
import { JsonObjectBodyPipe } from '../json-body.pipe';
import { ResourceIdPipe } from '../resource-id.pipe';
import { Orders } from './orders';

/**
 * The product orders of the ordering API, as far as the portal uses them: the list of the caller, one order, a new order and a
 * change (see `Orders`). Everything else under /ordering is closed here, so it is not handed to the legacy application.
 */
@UseInterceptors(BodyTextInterceptor)
@Controller('ordering')
export class OrderingController {
    constructor(private readonly orders: Orders) {}

    @Get('productOrder')
    list(@Req() req: Request, @Res() res: Response): Promise<void> {
        return this.orders.list(req, res);
    }

    @Get('productOrder/:id')
    read(@Param('id', ResourceIdPipe) id: string, @Req() req: Request, @Res() res: Response): Promise<void> {
        return this.orders.read(req, res, id);
    }

    @Post('productOrder')
    create(@Body(JsonObjectBodyPipe) body: string, @Req() req: Request, @Res() res: Response): Promise<void> {
        return this.orders.create(req, res, body);
    }

    @Patch('productOrder/:id')
    update(@Param('id', ResourceIdPipe) id: string, @Body(JsonObjectBodyPipe) body: string, @Req() req: Request, @Res() res: Response): Promise<void> {
        return this.orders.update(req, res, id, body);
    }

    @All(['', '{*path}'])
    closed(): never {
        throw new NotFoundError('Not found');
    }
}
