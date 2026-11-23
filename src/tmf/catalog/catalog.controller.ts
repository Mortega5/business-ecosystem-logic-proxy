import { All, Body, Controller, Delete, Get, Param, Patch, Post, Req, Res, UseGuards, UseInterceptors } from '@nestjs/common';
import type { Request, Response } from 'express';
import { OptionalAuth } from '../../auth/public.decorator';
import { NotFoundError } from '../../common/domain-error';
import { AdministratorGuard } from '../administrator.guard';
import { BodyTextInterceptor } from '../body-text.interceptor';
import { JsonObjectBodyPipe } from '../json-body.pipe';
import { ResourceIdPipe } from '../resource-id.pipe';
import { Categories } from './categories';
import { Catalogs } from './catalogs';
import { Offerings } from './offerings';
import { ProductSpecifications } from './product-specifications';

/**
 * The catalog API, as far as it has been moved here: the categories, which anybody reads and an administrator changes, and the
 * catalogs, the offerings and the product specifications, which a seller makes, changes and retires. What is not here yet (the lists of catalogs and offerings and the prices) is answered by the legacy application, and what is here and is not a route of the portal (the delete of a
 * category, above all) is closed, so it cannot reach it.
 */
@UseInterceptors(BodyTextInterceptor)
@Controller('catalog')
export class CatalogController {
    constructor(
        private readonly categories: Categories,
        private readonly catalogs: Catalogs,
        private readonly offerings: Offerings,
        private readonly products: ProductSpecifications
    ) {}

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

    @OptionalAuth()
    @Get('catalog/:id')
    readCatalog(@Param('id', ResourceIdPipe) id: string, @Req() req: Request, @Res() res: Response): Promise<void> {
        return this.catalogs.read(req, res, id);
    }

    @Post('catalog')
    createCatalog(@Body(JsonObjectBodyPipe) body: string, @Req() req: Request, @Res() res: Response): Promise<void> {
        return this.catalogs.create(req, res, body);
    }

    @Patch('catalog/:id')
    updateCatalog(@Param('id', ResourceIdPipe) id: string, @Body(JsonObjectBodyPipe) body: string, @Req() req: Request, @Res() res: Response): Promise<void> {
        return this.catalogs.update(req, res, id, body);
    }

    @Delete('catalog/:id')
    retireCatalog(@Param('id', ResourceIdPipe) id: string, @Req() req: Request, @Res() res: Response): Promise<void> {
        return this.catalogs.retire(req, res, id);
    }

    @OptionalAuth()
    @Get('productOffering/:id')
    readOffering(@Param('id', ResourceIdPipe) id: string, @Req() req: Request, @Res() res: Response): Promise<void> {
        return this.offerings.read(req, res, id);
    }

    @Post('productOffering')
    createOffering(@Body(JsonObjectBodyPipe) body: string, @Req() req: Request, @Res() res: Response): Promise<void> {
        return this.offerings.create(req, res, body);
    }

    @Post('catalog/:catalogId/productOffering')
    createOfferingInCatalog(@Param('catalogId', ResourceIdPipe) catalogId: string, @Body(JsonObjectBodyPipe) body: string, @Req() req: Request, @Res() res: Response): Promise<void> {
        return this.offerings.create(req, res, body, catalogId);
    }

    @Patch('productOffering/:id')
    updateOffering(@Param('id', ResourceIdPipe) id: string, @Body(JsonObjectBodyPipe) body: string, @Req() req: Request, @Res() res: Response): Promise<void> {
        return this.offerings.update(req, res, id, body);
    }

    @Delete('productOffering/:id')
    retireOffering(@Param('id', ResourceIdPipe) id: string, @Req() req: Request, @Res() res: Response): Promise<void> {
        return this.offerings.retire(req, res, id);
    }

    @OptionalAuth()
    @Get('productSpecification')
    listProducts(@Req() req: Request, @Res() res: Response): Promise<void> {
        return this.products.list(req, res);
    }

    @OptionalAuth()
    @Get('productSpecification/:id')
    readProduct(@Param('id', ResourceIdPipe) id: string, @Req() req: Request, @Res() res: Response): Promise<void> {
        return this.products.read(req, res, id);
    }

    @Post('productSpecification')
    createProduct(@Body(JsonObjectBodyPipe) body: string, @Req() req: Request, @Res() res: Response): Promise<void> {
        return this.products.create(req, res, body);
    }

    @Patch('productSpecification/:id')
    updateProduct(@Param('id', ResourceIdPipe) id: string, @Body(JsonObjectBodyPipe) body: string, @Req() req: Request, @Res() res: Response): Promise<void> {
        return this.products.update(req, res, id, body);
    }

    @Delete('productSpecification/:id')
    retireProduct(@Param('id', ResourceIdPipe) id: string, @Req() req: Request, @Res() res: Response): Promise<void> {
        return this.products.retire(req, res, id);
    }
}
