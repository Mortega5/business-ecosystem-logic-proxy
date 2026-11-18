import { All, Body, Controller, Delete, Get, Param, Patch, Post, Req, Res, UseInterceptors } from '@nestjs/common';
import type { Request, Response } from 'express';
import { BodyTextInterceptor } from '../body-text.interceptor';
import { OptionalAuth } from '../../auth/public.decorator';
import { NotFoundError } from '../../common/domain-error';
import { AppConfigService } from '../../config/app-config.service';
import { JsonBodyPipe } from '../json-body.pipe';
import { OwnedResources } from '../owned-resources';
import { ResourceIdPipe } from '../resource-id.pipe';
import { SellerParties } from '../seller-parties';
import { Specifications, type SpecificationApi } from '../specification/specifications';
import { TmfProxy } from '../tmf-proxy';

const SERVICE_SPECIFICATIONS: SpecificationApi = {
    upstream: 'tmforum.service',
    collection: 'serviceSpecification',
    productSpecificationField: 'serviceSpecification.id',
    noun: 'Service spec',
    messages: {
        list: 'You are not authorized to list the service specs',
        read: 'Unauthorized to read a service spec that is not launched',
        create: 'Unauthorized to create non-owned/non-seller service specs',
        update: 'Unauthorized to update non-owned/non-seller services',
        missing: 'The required service does not exist',
        retireInUse: 'Cannot retire a service spec without retiring all service specs linked with it'
    }
};

/**
 * The service specifications of the service catalog, as far as the portal uses them (see `Specifications` for the rules).
 * Everything else under /service is closed here, so it is not handed to the legacy application.
 */
@UseInterceptors(BodyTextInterceptor)
@Controller('service')
export class ServiceController {
    private readonly specifications: Specifications;

    constructor(proxy: TmfProxy, owned: OwnedResources, config: AppConfigService, sellers: SellerParties) {
        this.specifications = new Specifications(proxy, owned, config, sellers, SERVICE_SPECIFICATIONS);
    }

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
