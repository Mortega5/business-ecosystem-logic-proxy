import { Injectable, Logger } from '@nestjs/common';
import type { Request } from 'express';
import { BadGatewayError } from '../../common/domain-error';
import { AppConfigService } from '../../config/app-config.service';
import { AS_JSON } from '../http-options';
import { isRecord } from '../related-party';
import { parseJson } from '../specification/specifications';
import { TmfProxy } from '../tmf-proxy';

type Json = Record<string, unknown>;

const PAGE = 100;
const BATCH = 10;
const CONSTRAINT = 'constraint';

const failure = (): BadGatewayError => new BadGatewayError('The references to the removed product specification characteristics could not be updated');

const listOf = (value: unknown): unknown[] => (Array.isArray(value) ? (value as unknown[]) : value ? [value] : []);

const idsOf = (values: unknown[]): string[] => values.flatMap((value) => (isRecord(value) && typeof value['id'] === 'string' && value['id'] !== '' ? [value['id']] : []));

/**
 * The prices that use a characteristic of a product: when the characteristic is removed from the product, the prices that name it in
 * what they apply to (`prodSpecCharValueUse`) stop naming it. They are found from the offerings of the product, through the price
 * plans of each offering, the components of each plan and the constraint that a plan may point at.
 */
@Injectable()
export class PriceReferences {
    private readonly logger = new Logger(PriceReferences.name);

    constructor(
        private readonly proxy: TmfProxy,
        private readonly config: AppConfigService
    ) {}

    async remove(req: Request, productId: string, removed: string[]): Promise<void> {
        const plans = await this.prices(req, await this.planIds(req, productId));
        const related = new Set<string>();
        for (const plan of plans) {
            idsOf(listOf(plan['bundledPopRelationship'])).forEach((id) => related.add(id));
            idsOf(listOf(plan['popRelationship']).filter((one) => isRecord(one) && typeof one['relationshipType'] === 'string' && one['relationshipType'].toLowerCase() === CONSTRAINT)).forEach((id) => related.add(id));
        }
        const gone = new Set(removed);
        let cleaned = 0;
        for (const price of await this.prices(req, [...related])) {
            const uses = listOf(price['prodSpecCharValueUse']);
            const kept = uses.filter((use) => !isRecord(use) || !gone.has(String(use['id'])));
            if (kept.length === uses.length) {
                continue;
            }
            const response = await this.proxy.send(req, {
                upstream: 'tmforum.catalog',
                path: `/productOfferingPrice/${encodeURIComponent(String(price['id']))}`,
                method: 'PATCH',
                body: JSON.stringify({ prodSpecCharValueUse: kept }),
                ...AS_JSON,
                search: ''
            });
            if (response.status >= 400) {
                this.logger.warn(`The price ${String(price['id'])} could not be cleaned of the characteristics removed from the product ${productId}: answered ${response.status}`);
                throw failure();
            }
            cleaned += 1;
        }
        this.logger.log(`The characteristics removed from the product ${productId} were taken out of ${cleaned} prices`);
    }

    /** The price plans of the offerings of the product. */
    private async planIds(req: Request, productId: string): Promise<string[]> {
        const ids: string[] = [];
        for (let page = 0; page < this.config.limits.readAll.maxPages; page += 1) {
            const search = `?productSpecification.id=${encodeURIComponent(productId)}&limit=${PAGE}&offset=${page * PAGE}`;
            const response = await this.proxy.send(req, { upstream: 'tmforum.catalog', path: '/productOffering', method: 'GET', search });
            const offerings = parseJson(response.body);
            if (response.status >= 400) {
                throw failure();
            }
            const found = Array.isArray(offerings) ? (offerings as unknown[]) : [];
            for (const offering of found) {
                if (isRecord(offering)) {
                    ids.push(...idsOf(listOf(offering['productOfferingPrice'])));
                }
            }
            if (found.length < PAGE) {
                return ids;
            }
        }
        throw failure();
    }

    private async prices(req: Request, wanted: string[]): Promise<Json[]> {
        const unique = [...new Set(wanted)];
        const found = new Map<string, Json>();
        for (let from = 0; from < unique.length; from += BATCH) {
            const batch = unique.slice(from, from + BATCH);
            const search = `?id=${batch.map(encodeURIComponent).join(',')}&limit=${batch.length}`;
            const response = await this.proxy.send(req, { upstream: 'tmforum.catalog', path: '/productOfferingPrice', method: 'GET', search });
            const prices = parseJson(response.body);
            if (response.status >= 400) {
                throw failure();
            }
            for (const price of Array.isArray(prices) ? (prices as unknown[]) : []) {
                if (isRecord(price) && typeof price['id'] === 'string') {
                    found.set(price['id'], price);
                }
            }
        }
        return [...found.values()];
    }
}
