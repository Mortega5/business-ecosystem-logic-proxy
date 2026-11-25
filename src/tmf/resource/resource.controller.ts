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

const RESOURCE_SPECIFICATIONS: SpecificationApi = {
    upstream: 'tmforum.resource',
    collection: 'resourceSpecification',
    dependents: { upstream: 'tmforum.catalog', path: '/productSpecification', field: 'resourceSpecification.id', noun: 'product specs' },
    noun: 'Resource spec',
    messages: {
        list: 'You are not authorized to list the resource specs',
        read: 'Unauthorized to read a resource spec that is not launched',
        create: 'Unauthorized to create non-owned/non-seller resource specs',
        update: 'Unauthorized to update non-owned/non-seller resource specs',
        missing: 'The required resource does not exist',
        retireInUse: () => 'Cannot retire a resource spec without retiring all product specs linked with it'
    }
};

/**
 * The resource specifications of the resource catalog, as far as the portal uses them (see `Specifications` for the rules).
 * Everything else under /resource is closed here.
 */
@UseInterceptors(BodyTextInterceptor)
@Controller('resource')
export class ResourceController {
    private readonly specifications: Specifications;

    constructor(proxy: TmfProxy, owned: OwnedResources, config: AppConfigService, sellers: SellerParties) {
        this.specifications = new Specifications(proxy, owned, config, sellers, RESOURCE_SPECIFICATIONS);
    }

    @Get('resourceSpecification')
    list(@Req() req: Request, @Res() res: Response): Promise<void> {
        return this.specifications.list(req, res);
    }

    @OptionalAuth()
    @Get('resourceSpecification/:id')
    read(@Param('id', ResourceIdPipe) id: string, @Req() req: Request, @Res() res: Response): Promise<void> {
        return this.specifications.read(req, res, id);
    }

    @Post('resourceSpecification')
    create(@Body(JsonBodyPipe) body: string, @Req() req: Request, @Res() res: Response): Promise<void> {
        return this.specifications.create(req, res, body);
    }

    @Patch('resourceSpecification/:id')
    update(@Param('id', ResourceIdPipe) id: string, @Body(JsonBodyPipe) body: string, @Req() req: Request, @Res() res: Response): Promise<void> {
        return this.specifications.update(req, res, id, body);
    }

    @Delete('resourceSpecification/:id')
    retire(@Param('id', ResourceIdPipe) id: string, @Req() req: Request, @Res() res: Response): Promise<void> {
        return this.specifications.retire(req, res, id);
    }

    @All(['', '{*path}'])
    closed(): never {
        throw new NotFoundError('Not found');
    }
}
