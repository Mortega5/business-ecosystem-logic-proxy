import { All, Body, Controller, Delete, Get, Param, Patch, Post, Req, Res, UseInterceptors } from '@nestjs/common';
import type { Request, Response } from 'express';
import { BodyTextInterceptor } from '../body-text.interceptor';
import { OptionalAuth } from '../../auth/public.decorator';
import { NotFoundError } from '../../common/domain-error';
import { JsonBodyPipe } from '../json-body.pipe';
import { ResourceIdPipe } from '../resource-id.pipe';
import { ServiceSpecifications } from './service-specifications';

/**
 * The service specifications of the service catalog, as far as the portal uses them (see `Specifications` for the rules).
 * Everything else under /service is closed here, so it is not handed to the legacy application.
 */
@UseInterceptors(BodyTextInterceptor)
@Controller('service')
export class ServiceController {
    constructor(private readonly specifications: ServiceSpecifications) {}

    @Get('serviceSpecification')
    list(@Req() req: Request, @Res() res: Response): Promise<void> {
        return this.specifications.list(req, res);
    }

    @OptionalAuth()
    @Get('serviceSpecification/:id')
    read(@Param('id', ResourceIdPipe) id: string, @Req() req: Request, @Res() res: Response): Promise<void> {
        return this.specifications.read(req, res, id);
    }

    @Post('serviceSpecification')
    create(@Body(JsonBodyPipe) body: string, @Req() req: Request, @Res() res: Response): Promise<void> {
        return this.specifications.create(req, res, body);
    }

    @Patch('serviceSpecification/:id')
    update(@Param('id', ResourceIdPipe) id: string, @Body(JsonBodyPipe) body: string, @Req() req: Request, @Res() res: Response): Promise<void> {
        return this.specifications.update(req, res, id, body);
    }

    @Delete('serviceSpecification/:id')
    retire(@Param('id', ResourceIdPipe) id: string, @Req() req: Request, @Res() res: Response): Promise<void> {
        return this.specifications.retire(req, res, id);
    }

    @All(['', '{*path}'])
    closed(): never {
        throw new NotFoundError('Not found');
    }
}
