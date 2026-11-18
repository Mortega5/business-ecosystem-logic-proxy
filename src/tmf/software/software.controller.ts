import { All, Body, Controller, Delete, Get, Param, Patch, Post, Req, Res, UseInterceptors } from '@nestjs/common';
import type { Request, Response } from 'express';
import { OptionalAuth } from '../../auth/public.decorator';
import { NotFoundError } from '../../common/domain-error';
import { AppConfigService } from '../../config/app-config.service';
import { BodyTextInterceptor } from '../body-text.interceptor';
import { JsonBodyPipe } from '../json-body.pipe';
import { OwnedResources } from '../owned-resources';
import { ResourceIdPipe } from '../resource-id.pipe';
import { SellerParties } from '../seller-parties';
import type { SpecificationApi } from '../specification/specifications';
import { TmfProxy } from '../tmf-proxy';
import { SoftwareSpecifications } from './software-specifications';

const MESSAGES = {
    list: 'You are not authorized to list the resource specs',
    read: 'Unauthorized to read a resource spec that is not launched',
    create: 'Unauthorized to create non-owned/non-seller resource specs',
    update: 'Unauthorized to update non-owned/non-seller resource specs',
    missing: 'The required resource does not exist'
};

// A specification of software is retired when no resource made from it is left
const SPECIFICATIONS: SpecificationApi = {
    upstream: 'tmforum.software',
    collection: 'resourceSpecification',
    noun: 'Resource spec',
    dependents: { upstream: 'tmforum.software', path: '/resource', field: 'resourceSpecification.id', noun: 'resources' },
    messages: {
        ...MESSAGES,
        retireInUse: (inUse) =>
            `Cannot retire a resource spec without retiring all resources linked with it (blocked by resources ${inUse.map((resource) => String(resource['id'])).join(', ')})`
    }
};

// The support packages, which are resources of the API; they are the seller's own and are never given to anybody else
const PACKAGES: SpecificationApi = {
    upstream: 'tmforum.software',
    collection: 'resource',
    noun: 'Resource spec',
    privateReads: true,
    messages: { ...MESSAGES, retireInUse: () => '' }
};

/**
 * The software API, as far as the portal uses it: the specifications of software and the support packages that go with them (see
 * `SoftwareSpecifications` for what that means). A support package has the deployment characteristics, so it is read only by the
 * seller who owns it. Everything else under /software is closed here, so it is not handed to the legacy application.
 */
@UseInterceptors(BodyTextInterceptor)
@Controller('software')
export class SoftwareController {
    private readonly specifications: SoftwareSpecifications;
    private readonly packages: SoftwareSpecifications;

    constructor(proxy: TmfProxy, owned: OwnedResources, config: AppConfigService, sellers: SellerParties) {
        this.specifications = new SoftwareSpecifications(proxy, owned, config, sellers, SPECIFICATIONS);
        this.packages = new SoftwareSpecifications(proxy, owned, config, sellers, PACKAGES);
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

    @Get('resource')
    listPackages(@Req() req: Request, @Res() res: Response): Promise<void> {
        return this.packages.list(req, res);
    }

    @Get('resource/:id')
    readPackage(@Param('id', ResourceIdPipe) id: string, @Req() req: Request, @Res() res: Response): Promise<void> {
        return this.packages.read(req, res, id);
    }

    @Post('resource')
    createPackage(@Body(JsonBodyPipe) body: string, @Req() req: Request, @Res() res: Response): Promise<void> {
        return this.packages.create(req, res, body);
    }

    @Patch('resource/:id')
    updatePackage(@Param('id', ResourceIdPipe) id: string, @Body(JsonBodyPipe) body: string, @Req() req: Request, @Res() res: Response): Promise<void> {
        return this.packages.update(req, res, id, body);
    }

    @All(['', '{*path}'])
    closed(): never {
        throw new NotFoundError('Not found');
    }
}
