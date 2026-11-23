import type { Request } from 'express';
import { BadGatewayError, DomainError } from '../../common/domain-error';
import { isRecord } from '../related-party';
import { isInUse } from '../specification/specification-rules';
import { parseJson, Specifications, type Undo } from '../specification/specifications';

const PAGE = 100;
const MAX_PAGES = 50;
// The offers asked for in one query, so the address of the request stays short however many price plans there are
const PLANS_PER_QUERY = 20;

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
            for (let from = 0; from < plans.length; from += PLANS_PER_QUERY) {
                const ids = plans.slice(from, from + PLANS_PER_QUERY).map(encodeURIComponent).join(',');
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
        for (const price of await this.all(req, '/productOfferingPrice', `usageSpecId=${encodeURIComponent(id)}`)) {
            const priceId = String(price['id']);
            if (price['isBundle'] === true) {
                plans.add(priceId);
                continue;
            }
            for (const plan of await this.all(req, '/productOfferingPrice', `bundledPopRelationship.id=${encodeURIComponent(priceId)}`)) {
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
        for (let page = 0; page < MAX_PAGES; page += 1) {
            const response = await this.proxy.send(req, { upstream: 'tmforum.catalog', path, method: 'GET', search: `?${query}&limit=${PAGE}&offset=${page * PAGE}` });
            const items = parseJson(response.body);
            if (response.status >= 400 || !Array.isArray(items)) {
                throw new BadGatewayError(UNREADABLE_OFFERS);
            }
            found.push(...(items as unknown[]).filter(isRecord));
            if (items.length < PAGE) {
                return found;
            }
        }
        throw new BadGatewayError(UNREADABLE_OFFERS);
    }
}
