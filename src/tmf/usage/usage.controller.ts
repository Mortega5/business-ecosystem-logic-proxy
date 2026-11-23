import { All, Body, Controller, Get, Param, Patch, Post, Req, Res, UseInterceptors } from '@nestjs/common';
import type { Request, Response } from 'express';
import { NotFoundError } from '../../common/domain-error';
import { AppConfigService } from '../../config/app-config.service';
import { BodyTextInterceptor } from '../body-text.interceptor';
import { JsonBodyPipe } from '../json-body.pipe';
import { OwnedResources } from '../owned-resources';
import { ResourceIdPipe } from '../resource-id.pipe';
import { SellerParties } from '../seller-parties';
import type { SpecificationApi } from '../specification/specifications';
import { TmfProxy } from '../tmf-proxy';
import { UsageSpecifications } from './usage-specifications';

const USAGE_SPECIFICATIONS: SpecificationApi = {
    upstream: 'tmforum.usage',
    collection: 'usageSpecification',
    noun: 'Usage spec',
    privateReads: true,
    messages: {
        list: 'invalid request',
        read: 'Unauthorized to read a usage spec that is not yours',
        create: 'Unauthorized to create/update non-owned usage specs',
        update: 'Unauthorized to create/update non-owned usage specs',
        missing: 'The required usage spec does not exist',
        retireInUse: () => 'The usage spec cannot be deleted because it is being used by active or launched product offers'
    }
};

/**
 * The usage specifications of a seller, as far as the portal uses them: the list of the caller, a create and a change (see
 * `UsageSpecifications`). Everything else under /usage, the usage records and the delete of a specification, is closed here.
 */
@UseInterceptors(BodyTextInterceptor)
@Controller('usage')
export class UsageController {
    private readonly specifications: UsageSpecifications;

    constructor(proxy: TmfProxy, owned: OwnedResources, config: AppConfigService, sellers: SellerParties) {
        this.specifications = new UsageSpecifications(proxy, owned, config, sellers, USAGE_SPECIFICATIONS);
    }

    @Get('usageSpecification')
    list(@Req() req: Request, @Res() res: Response): Promise<void> {
        return this.specifications.list(req, res);
    }

    @Post('usageSpecification')
    create(@Body(JsonBodyPipe) body: string, @Req() req: Request, @Res() res: Response): Promise<void> {
        return this.specifications.create(req, res, body);
    }

    @Patch('usageSpecification/:id')
    update(@Param('id', ResourceIdPipe) id: string, @Body(JsonBodyPipe) body: string, @Req() req: Request, @Res() res: Response): Promise<void> {
        return this.specifications.update(req, res, id, body);
    }

    @All(['', '{*path}'])
    closed(): never {
        throw new NotFoundError('Not found');
    }
}
