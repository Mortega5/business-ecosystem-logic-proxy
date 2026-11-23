import { All, Body, Controller, Get, Param, Patch, Post, Req, Res, UseGuards, UseInterceptors } from '@nestjs/common';
import type { Request, Response } from 'express';
import { OptionalAuth } from '../../auth/public.decorator';
import { NotFoundError } from '../../common/domain-error';
import { AdministratorGuard } from '../administrator.guard';
import { BodyTextInterceptor } from '../body-text.interceptor';
import { JsonObjectBodyPipe } from '../json-body.pipe';
import { ResourceIdPipe } from '../resource-id.pipe';
import { Categories } from './categories';

/**
 * The catalog API, as far as it has been moved here: the categories, which anybody reads and an administrator changes. What is
 * not here yet is answered by the legacy application, and what is here and is not a route of the portal (the delete of a category,
 * above all) is closed, so it cannot reach it.
 */
@UseInterceptors(BodyTextInterceptor)
@Controller('catalog')
export class CatalogController {
    constructor(private readonly categories: Categories) {}

    @OptionalAuth()
    @Get('category')
    listCategories(@Req() req: Request, @Res() res: Response): Promise<void> {
        return this.categories.list(req, res);
    }

    @OptionalAuth()
    @Get('category/:id')
    readCategory(@Param('id', ResourceIdPipe) id: string, @Req() req: Request, @Res() res: Response): Promise<void> {
        return this.categories.read(req, res, id);
    }

    @UseGuards(AdministratorGuard)
    @Post('category')
    createCategory(@Body(JsonObjectBodyPipe) body: string, @Req() req: Request, @Res() res: Response): Promise<void> {
        return this.categories.create(req, res, body);
    }

    @UseGuards(AdministratorGuard)
    @Patch('category/:id')
    updateCategory(@Param('id', ResourceIdPipe) id: string, @Body(JsonObjectBodyPipe) body: string, @Req() req: Request, @Res() res: Response): Promise<void> {
        return this.categories.update(req, res, id, body);
    }

    @All(['category', 'category/{*path}'])
    closedCategories(): never {
        throw new NotFoundError('Not found');
    }
}
