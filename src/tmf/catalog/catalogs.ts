import { Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { BadGatewayError, DomainError } from '../../common/domain-error';
import { AppConfigService } from '../../config/app-config.service';
import { AS_JSON } from '../http-options';
import { OwnedResources } from '../owned-resources';
import { isRecord } from '../related-party';
import { SellerParties } from '../seller-parties';
import { parseJson, Specifications, type SpecificationApi, type Undo } from '../specification/specifications';
import { TmfProxy } from '../tmf-proxy';
import type { UpstreamUser } from '../upstream-headers';

// What a catalog name cannot have; it goes to the search of the portal and to the queries of the API
const INVALID_NAME = /[<>%'"|]/;

const CATALOG: SpecificationApi = {
    upstream: 'tmforum.catalog',
    collection: 'catalog',
    noun: 'Catalog',
    dependents: { upstream: 'tmforum.catalog', path: '/productOffering', field: 'category.id', noun: 'offerings' },
    messages: {
        list: 'You are not authorized to list the catalogs',
        read: 'Unauthorized to read a catalog that is not launched',
        create: 'You are not authorized to create resources',
        update: 'The user making the request is not the owner of the accessed resource',
        missing: 'The required resource does not exist',
        retireInUse: (inUse) => `Cannot retire a catalog without retiring all the offerings in it (blocked by offerings ${inUse.map((offering) => String(offering['id'])).join(', ')})`
    }
};

const categoryIds = (catalog: Record<string, unknown>): string[] =>
    (Array.isArray(catalog['category']) ? (catalog['category'] as unknown[]) : []).flatMap((category) => (isRecord(category) && typeof category['id'] === 'string' ? [category['id']] : []));

/**
 * The catalogs a seller owns. A catalog has a name that no other has and a root category of its own, which is made with it and
 * is what the offerings of the catalog point at, so a catalog cannot be given other categories and is retired only when its
 * offerings are. When the catalog cannot be made the category is retired again.
 */
@Injectable()
export class Catalogs extends Specifications {
    constructor(proxy: TmfProxy, owned: OwnedResources, config: AppConfigService, sellers: SellerParties) {
        super(proxy, owned, config, sellers, CATALOG);
    }

    protected override async beforeCreate(req: Request, catalog: Record<string, unknown>): Promise<Undo | undefined> {
        await this.assertNameFree(req, catalog['name'], undefined);
        catalog['validFor'] ??= { startDateTime: new Date().toISOString() };
        const [seller] = catalog['relatedParty'] as Record<string, unknown>[];
        const category = {
            isRoot: true,
            name: catalog['name'],
            lifecycleStatus: 'Launched',
            relatedParty: this.sellers.of(seller as Record<string, unknown>, (req as Request & { user: UpstreamUser }).user)
        };
        const response = await this.proxy.send(req, { upstream: 'tmforum.catalog', path: '/category', body: JSON.stringify(category), ...AS_JSON, search: '' });
        const created = parseJson(response.body);
        if (response.status >= 400 || !isRecord(created) || typeof created['id'] !== 'string') {
            throw new BadGatewayError('Error creating the associated category');
        }
        catalog['category'] = [{ id: created['id'], href: created['href'], name: created['name'] }];
        return async () => {
            try {
                const retired = await this.proxy.send(req, {
                    upstream: 'tmforum.catalog',
                    path: `/category/${encodeURIComponent(created['id'] as string)}`,
                    method: 'PATCH',
                    body: JSON.stringify({ lifecycleStatus: 'Retired' }),
                    ...AS_JSON,
                    search: ''
                });
                return retired.status < 400 ? undefined : `the category ${created['id'] as string} could not be retired`;
            } catch {
                return `the category ${created['id'] as string} could not be retired`;
            }
        };
    }

    protected override async beforeUpdate(req: Request, id: string, current: Record<string, unknown>, changes: Record<string, unknown>): Promise<void> {
        if ('category' in changes && categoryIds(changes).toSorted().join() !== categoryIds(current).toSorted().join()) {
            throw new DomainError('The field "category" can not be modified', 409);
        }
        if (typeof changes['name'] === 'string') {
            await this.assertNameFree(req, changes['name'], id);
        }
    }

    protected override async dependentsFilter(req: Request, id: string): Promise<string | undefined> {
        const response = await this.proxy.send(req, { upstream: 'tmforum.catalog', path: this.path(id), method: 'GET', search: '' });
        const catalog = parseJson(response.body);
        if (response.status >= 400 || !isRecord(catalog)) {
            throw new BadGatewayError('The catalog could not be read');
        }
        const ids = categoryIds(catalog);
        return ids.length === 0 ? undefined : `category.id=${ids.map(encodeURIComponent).join(',')}`;
    }

    private async assertNameFree(req: Request, name: unknown, own: string | undefined): Promise<void> {
        if (typeof name !== 'string' || INVALID_NAME.test(name)) {
            throw new DomainError('Invalid format, these characters have been temporarily disabled', 400);
        }
        const response = await this.proxy.send(req, { upstream: 'tmforum.catalog', path: '/catalog', method: 'GET', search: `?name=${encodeURIComponent(name)}` });
        const same = parseJson(response.body);
        if (response.status >= 400 || !Array.isArray(same)) {
            throw new BadGatewayError('It was impossible to check if there is another catalog with the same name');
        }
        if (same.some((other) => !isRecord(other) || other['id'] !== own)) {
            throw new DomainError('This catalog name is already taken', 409);
        }
    }
}
