import { Body, Controller, Delete, Get, HttpCode, Param, Post, Req, Res, UseInterceptors, All } from '@nestjs/common';
import type { Request, Response } from 'express';
import { NotFoundError } from '../common/domain-error';
import { BodyTextInterceptor } from '../tmf/body-text.interceptor';
import { JsonObjectBodyPipe } from '../tmf/json-body.pipe';
import { ResourceIdPipe } from '../tmf/resource-id.pipe';
import type { UpstreamUser } from '../tmf/upstream-headers';
import { CartService } from './cart.service';

const ITEMS = '/shoppingCart/item';

/** The shopping cart of the caller, as far as the portal uses it: its items, add one, remove one and empty it. Everything else is closed. */
@UseInterceptors(BodyTextInterceptor)
@Controller('shoppingCart')
export class CartController {
    constructor(private readonly cart: CartService) {}

    @Get('item')
    list(@Req() req: Request): Promise<Record<string, unknown>[]> {
        return this.cart.list(userOf(req));
    }

    @Post('item')
    async add(@Body(JsonObjectBodyPipe) body: string, @Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<{ status: string }> {
        const id = await this.cart.add(userOf(req), body);
        res.status(201).setHeader('location', `${ITEMS}/${encodeURIComponent(id)}`);
        return { status: 'ok' };
    }

    @Delete('item/:id')
    @HttpCode(204)
    remove(@Param('id', ResourceIdPipe) id: string, @Req() req: Request): Promise<void> {
        return this.cart.remove(userOf(req), id);
    }

    @Post('empty')
    @HttpCode(204)
    empty(@Req() req: Request): Promise<void> {
        return this.cart.empty(userOf(req));
    }

    @All(['', '{*path}'])
    closed(): never {
        throw new NotFoundError('Not found');
    }
}

// The route is private, so the authentication has put the user there
const userOf = (req: Request): string => (req as Request & { user: UpstreamUser }).user.id;
