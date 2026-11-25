import { Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { AppConfigService } from '../../config/app-config.service';
import { FileGuards } from '../../files/file-guards';
import { OwnedResources } from '../owned-resources';
import { SellerParties } from '../seller-parties';
import { Specifications, type SpecificationApi, type Undo } from '../specification/specifications';
import { TmfProxy } from '../tmf-proxy';

export const SERVICE_SPECIFICATIONS: SpecificationApi = {
    upstream: 'tmforum.service',
    collection: 'serviceSpecification',
    dependents: {
        upstream: 'tmforum.catalog',
        path: '/productSpecification',
        field: 'serviceSpecification.id',
        noun: 'product specs'
    },
    noun: 'Service spec',
    messages: {
        list: 'You are not authorized to list the service specs',
        read: 'Unauthorized to read a service spec that is not launched',
        create: 'Unauthorized to create non-owned/non-seller service specs',
        update: 'Unauthorized to update non-owned/non-seller services',
        missing: 'The required service does not exist',
        retireInUse: () => 'Cannot retire a service spec without retiring all service specs linked with it'
    }
};

/**
 * The service specifications. The portal writes the one of a dataset like any other; what the proxy adds is that a file it points at has
 * to be one of the seller's, because the policy of the product grants reading that file.
 */
@Injectable()
export class ServiceSpecifications extends Specifications {
    constructor(
        proxy: TmfProxy,
        owned: OwnedResources,
        config: AppConfigService,
        sellers: SellerParties,
        private readonly files: FileGuards
    ) {
        super(proxy, owned, config, sellers, SERVICE_SPECIFICATIONS);
    }

    protected override async beforeCreate(
        req: Request,
        specification: Record<string, unknown>
    ): Promise<Undo | undefined> {
        await this.files.checkServiceSpecFiles(specification, partyOf(req));
        return undefined;
    }

    protected override async beforeUpdate(
        req: Request,
        _id: string,
        _current: Record<string, unknown>,
        changes: Record<string, unknown>
    ): Promise<Undo | undefined> {
        await this.files.checkServiceSpecFiles(changes, partyOf(req));
        return undefined;
    }
}

const partyOf = (req: Request): string | undefined => (req as Request & { user?: { partyId?: string } }).user?.partyId;
