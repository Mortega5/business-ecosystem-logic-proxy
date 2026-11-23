import type { Request } from 'express';
import { BadGatewayError, DomainError } from '../../common/domain-error';
import { isRecord } from '../related-party';
import { isInUse } from '../specification/specification-rules';
import { parseJson, Specifications, type Undo } from '../specification/specifications';

const IN_USE = 'The usage spec cannot be deleted because it is being used by active or launched product offers';
const UNREADABLE_OFFERS = 'The product offers using the usage spec cannot be retrieved';

/**
 * The usage specifications of the usage API. They are the seller's own and nobody else sees them; a usage spec is stamped with the
 * time of its last change, and one that is used by the price plans of an offer
 * that is still alive is not retired.
 */
export class UsageSpecifications extends Specifications {
    protected override beforeCreate(_req: Request, specification: Record<string, unknown>): Promise<Undo | undefined> {
        specification['lastUpdate'] = new Date().toISOString();
        return Promise.resolve(undefined);
    }

    protected override prepareUpdate(
        _current: Record<string, unknown>,
        changes: Record<string, unknown>
    ): { changes: Record<string, unknown>; after?: (req: Request) => Promise<void> } {
        return { changes: { ...changes, lastUpdate: new Date().toISOString() } };
    }

    /** A usage spec is in use while an offer that is not retired or obsolete has a price plan that charges for it. */
    protected override async assertNotInUse(req: Request, id: string): Promise<void> {
        let offers: Record<string, unknown>[];
        try {
            const plans = await this.pricePlansOf(req, id);
            offers = [];
            const { plansPerQuery } = this.config.limits;
            for (let from = 0; from < plans.length; from += plansPerQuery) {
                const ids = plans.slice(from, from + plansPerQuery).map(encodeURIComponent).join(',');
                offers.push(...(await this.all(req, '/productOffering', `productOfferingPrice.id=${ids}`)));
            }
        } catch {
            throw new BadGatewayError(UNREADABLE_OFFERS);
        }
        if (offers.some(isInUse)) {
            throw new DomainError(IN_USE, 409);
        }
    }

    /** The price plans (the bundles of prices) with a price that is by the usage spec, or that are the price themselves. */
    private async pricePlansOf(req: Request, id: string): Promise<string[]> {
        const plans = new Set<string>();
        const single: string[] = [];
        for (const price of await this.all(req, '/productOfferingPrice', `usageSpecId=${encodeURIComponent(id)}`)) {
            if (price['isBundle'] === true) {
                plans.add(String(price['id']));
            } else {
                single.push(String(price['id']));
            }
        }
        // A price is in the plans that bundle it; the ids of a batch are one query, as the TMForum takes several values for one field
        const { plansPerQuery } = this.config.limits;
        for (let from = 0; from < single.length; from += plansPerQuery) {
            const ids = single.slice(from, from + plansPerQuery).map(encodeURIComponent).join(',');
            for (const plan of await this.all(req, '/productOfferingPrice', `bundledPopRelationship.id=${ids}`)) {
                if (plan['isBundle'] === true) {
                    plans.add(String(plan['id']));
                }
            }
        }
        return [...plans];
    }

    /** Every item of a query of the catalog, page after page. */
    private async all(req: Request, path: string, query: string): Promise<Record<string, unknown>[]> {
        const found: Record<string, unknown>[] = [];
        const { pageSize, maxPages } = this.config.limits.readAll;
        for (let page = 0; page < maxPages; page += 1) {
            const response = await this.proxy.send(req, { upstream: 'tmforum.catalog', path, method: 'GET', search: `?${query}&limit=${pageSize}&offset=${page * pageSize}` });
            const items = parseJson(response.body);
            if (response.status >= 400 || !Array.isArray(items)) {
                throw new BadGatewayError(UNREADABLE_OFFERS);
            }
            found.push(...(items as unknown[]).filter(isRecord));
            if (items.length < pageSize) {
                return found;
            }
        }
        throw new BadGatewayError(UNREADABLE_OFFERS);
    }
}
