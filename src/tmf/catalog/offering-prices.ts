import { Injectable, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { pagination, queryParams } from '../schemas/pagination';
import { parseRequest } from '../schemas/parse';
import { DomainError, ForbiddenError, NotFoundError, BadGatewayError } from '../../common/domain-error';
import { AppConfigService } from '../../config/app-config.service';
import { AS_JSON } from '../http-options';
import { callerParty, isRecord, isRelatedAs } from '../related-party';
import { isResourceId } from '../resource-id.pipe';
import { isValidStatusTransition, sameRelatedParties } from '../specification/specification-rules';
import { parseJson } from '../specification/specifications';
import { TmfProxy } from '../tmf-proxy';
import type { UpstreamUser } from '../upstream-headers';
import { OfferingParties } from './offering-parties';
import { allowedByConstraint, amountsProblem, constraintRefOf, effective, isConstraint, isConstraintType, isPlainPrice, usesCompliance, valueUsesOf } from './price-rules';

type Json = Record<string, unknown>;

const PAGE = 100;
const BATCH = 10;
const NOT_OWNER = 'The user making the request is not the owner of the accessed resource';

// What anybody may ask of the list of prices, with what each filter may be
const pricesQuery = z.strictObject({
    ...pagination,
    id: z.string().regex(/^[A-Za-z0-9:._-]{1,200}(,[A-Za-z0-9:._-]{1,200}){0,99}$/).optional(),
    usageSpecId: z.string().regex(/^[A-Za-z0-9:._-]{1,200}$/).optional(),
    'bundledPopRelationship.id': z.string().regex(/^[A-Za-z0-9:._-]{1,200}$/).optional()
});

const parseObject = (text: string): Json => {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) {
        throw new DomainError('Invalid body', 400);
    }
    return parsed;
};

const shown = (value: unknown): string => (typeof value === 'string' ? value : JSON.stringify(value));

const refused = (message: string): DomainError => new DomainError(message, 422);

/**
 * The prices of the catalog API, as far as the portal uses them: anybody reads them; a seller makes them (a price plan, which holds
 * price components and may point at a constraint, a component, a discount or a constraint) and changes the ones that are theirs.
 * A plan only holds components that its constraint allows, and a component or a constraint cannot change into what the plans that
 * use it do not allow. A price is not deleted: an offering stops naming it.
 */
@Injectable()
export class OfferingPrices {
    private readonly logger = new Logger(OfferingPrices.name);

    constructor(
        private readonly proxy: TmfProxy,
        private readonly config: AppConfigService,
        private readonly parties: OfferingParties
    ) {}

    private path(id: string): string {
        return `/productOfferingPrice/${encodeURIComponent(id)}`;
    }

    // ---- Reads, open to anybody

    list(req: Request, res: Response): Promise<void> {
        const params = queryParams(req.query, parseRequest(pricesQuery, req.query, 'Invalid query'));
        return this.proxy.forward(req, res, { upstream: 'tmforum.catalog', path: '/productOfferingPrice', search: params.size === 0 ? '' : `?${params.toString()}` });
    }

    read(req: Request, res: Response, id: string): Promise<void> {
        return this.proxy.forward(req, res, { upstream: 'tmforum.catalog', path: this.path(id), search: '' });
    }

    // ---- Create

    async create(req: Request, res: Response, text: string): Promise<void> {
        const { id: _id, href: _href, ...price } = parseObject(text);
        const seller = this.config.auth.roles.seller.toLowerCase();
        if (!((req as Request & { user?: UpstreamUser }).user?.roles ?? []).some((role) => role.name.toLowerCase() === seller)) {
            throw new ForbiddenError('You are not authorized to create resources');
        }
        const partyId = callerParty(req, 'You are not authorized to create resources');
        this.parties.assertShape(price['relatedParty']);
        price['validFor'] ??= { startDateTime: new Date().toISOString() };
        await this.assertValid(req, price, null);
        price['relatedParty'] = await this.parties.of(req, price['relatedParty'], partyId);
        price['@schemaLocation'] = price['isBundle'] ? this.config.catalog.partyLocation : this.config.catalog.priceCompSchema;
        const response = await this.proxy.send(req, { upstream: 'tmforum.catalog', path: '/productOfferingPrice', method: 'POST', body: JSON.stringify(price), ...AS_JSON, search: '' });
        if (response.status < 400) {
            const created = parseJson(response.body);
            this.logger.log(`The price ${isRecord(created) ? String(created['id']) : '?'} was created as a ${price['isBundle'] ? 'plan' : 'component'}`);
        }
        this.proxy.reply(res, response);
    }

    // ---- Update

    async update(req: Request, res: Response, id: string, text: string): Promise<void> {
        const { id: _id, href: _href, ...changes } = parseObject(text);
        const partyId = callerParty(req, NOT_OWNER);
        const current = await this.readOne(req, id);
        if (!isRelatedAs(current, partyId, this.config.auth.roles.seller)) {
            throw new ForbiddenError(NOT_OWNER);
        }
        if ('relatedParty' in changes && !sameRelatedParties(current['relatedParty'], changes['relatedParty'])) {
            throw new DomainError('The field "relatedParty" can not be modified', 409);
        }
        if (current['validFor'] === undefined && changes['validFor'] === undefined) {
            changes['validFor'] = { startDateTime: new Date().toISOString() };
        }
        const status = changes['lifecycleStatus'];
        if (status !== undefined && status !== null && !isValidStatusTransition(current['lifecycleStatus'], status)) {
            throw new DomainError(`Cannot transition from lifecycle status ${shown(current['lifecycleStatus'])} to ${shown(status)}`, 400);
        }
        await this.assertValid(req, changes, current);
        if (!current['isBundle']) {
            changes['@schemaLocation'] = this.config.catalog.priceCompSchema;
        }
        const response = await this.proxy.send(req, { upstream: 'tmforum.catalog', path: this.path(id), body: JSON.stringify(changes), ...AS_JSON, search: '' });
        if (response.status < 400) {
            this.logger.log(`The price ${id} was changed`);
        }
        this.proxy.reply(res, response);
    }

    private async readOne(req: Request, id: string): Promise<Json> {
        const response = await this.proxy.send(req, { upstream: 'tmforum.catalog', path: this.path(id), method: 'GET', search: '' });
        if (response.status === 404) {
            throw new NotFoundError('The required resource does not exist');
        }
        const found = parseJson(response.body);
        if (response.status >= 400 || !isRecord(found)) {
            throw new BadGatewayError('The price could not be read');
        }
        return found;
    }

    // ---- What a price has to be

    /** What the amounts say, what it is made of and who else it affects, for a price that is made (no previous one) or changed. */
    private async assertValid(req: Request, price: Json, previous: Json | null): Promise<void> {
        const problem = amountsProblem(price);
        if (problem !== undefined) {
            throw refused(problem);
        }
        if (previous !== null && price['isBundle'] !== undefined && price['isBundle'] !== previous['isBundle']) {
            throw new ForbiddenError('Field isBundle cannot be modified');
        }
        const isPlan = previous === null ? price['isBundle'] : previous['isBundle'];
        const type = price['priceType'] !== undefined ? price['priceType'] : previous?.['priceType'];
        if (isPlan) {
            await this.assertPlan(req, price, previous);
        } else if (isConstraintType(type)) {
            await this.assertConstraint(req, price, previous);
        } else if (previous !== null && price['prodSpecCharValueUse'] !== undefined) {
            await this.assertComponent(req, price, previous);
        }
    }

    /** A plan points at no more than one constraint, does not apply to characteristics if it does, and holds components that the constraint allows. */
    private async assertPlan(req: Request, plan: Json, previous: Json | null): Promise<void> {
        const { ref, problem } = constraintRefOf(plan, previous);
        if (problem !== undefined) {
            throw refused(problem);
        }
        const uses = effective(plan, previous, 'prodSpecCharValueUse');
        if (ref !== undefined && Array.isArray(uses) && uses.length > 0) {
            throw refused('A price plan with prodSpecCharValueUse cannot reference a constraint');
        }
        if (previous === null || plan['bundledPopRelationship'] !== undefined || plan['popRelationship'] !== undefined) {
            await this.assertComponents(req, effective(plan, previous, 'bundledPopRelationship'), await this.constraintUses(req, ref));
        }
    }

    /** The characteristics that the constraint of a plan names; none when the plan has no constraint. */
    private async constraintUses(req: Request, ref: Json | undefined): Promise<Json[]> {
        if (ref === undefined) {
            return [];
        }
        const id = typeof ref['id'] === 'string' ? ref['id'] : JSON.stringify(ref['id']);
        const constraint = (await this.pricesById(req, [ref['id']], 'The constraint referenced by the price plan cannot be retrieved')).get(id);
        if (constraint === undefined) {
            throw refused(`The constraint ${id} referenced by the price plan cannot be accessed or does not exist`);
        }
        if (!isPlainPrice(constraint) || !isConstraint(constraint)) {
            throw refused('The constraint relationship must reference a non-bundled ProductOfferingPrice with priceType constraint');
        }
        return valueUsesOf(constraint);
    }

    /** The components of a plan exist, are components, are not constraints and use nothing that the constraint of the plan forbids. */
    private async assertComponents(req: Request, refs: unknown, constraintUses: Json[]): Promise<void> {
        if (!Array.isArray(refs) || refs.length === 0) {
            return;
        }
        for (const ref of refs as unknown[]) {
            if (!isRecord(ref) || !ref['id']) {
                throw refused('The price plan contains a price component reference without an id');
            }
        }
        const components = await this.pricesById(
            req,
            (refs as Json[]).map((ref) => ref['id']),
            'The price components referenced by the price plan cannot be retrieved'
        );
        for (const ref of refs as Json[]) {
            const id = typeof ref['id'] === 'string' ? ref['id'] : JSON.stringify(ref['id']);
            const component = components.get(id);
            if (component === undefined) {
                throw refused(`The price component ${id} referenced by the price plan cannot be accessed or does not exist`);
            }
            if (!isPlainPrice(component)) {
                throw refused('The price plan can only contain price components with isBundle set to false');
            }
            if (isConstraint(component)) {
                throw refused('A constraint price cannot be included as a price component of a price plan');
            }
            if (!allowedByConstraint(component, constraintUses)) {
                throw refused('The price plan contains a price component that uses a forbidden characteristic');
            }
        }
    }

    /** A component that changes what it applies to cannot use what the constraint of a plan that holds it forbids. */
    private async assertComponent(req: Request, component: Json, previous: Json): Promise<void> {
        if (valueUsesOf(component).length === 0) {
            return;
        }
        await this.eachPage(req, `bundledPopRelationship.id=${encodeURIComponent(String(previous['id']))}`, 'The price plans referencing the price component cannot be retrieved', async (plans) => {
            const refs: Json[] = [];
            for (const plan of plans) {
                const { ref, problem } = constraintRefOf(plan, null);
                if (problem !== undefined) {
                    throw refused(problem);
                }
                if (ref !== undefined) {
                    refs.push(ref);
                }
            }
            const constraints = await this.pricesById(
                req,
                refs.map((ref) => ref['id']),
                'The constraints referenced by the price plans cannot be retrieved'
            );
            for (const ref of refs) {
                const constraint = constraints.get(String(ref['id']));
                if (constraint === undefined || !isPlainPrice(constraint) || !isConstraint(constraint)) {
                    throw refused('A price plan references an invalid constraint price');
                }
                if (!allowedByConstraint(component, valueUsesOf(constraint))) {
                    throw refused('The price component uses a characteristic forbidden by one of its price plans');
                }
            }
        });
    }

    /** A constraint names no compliance characteristic, and the components of the plans that point at it use none of what it forbids once it changes. */
    private async assertConstraint(req: Request, constraint: Json, previous: Json | null): Promise<void> {
        if (usesCompliance(constraint)) {
            throw refused('Compliance characteristics cannot be used in price constraints');
        }
        const uses = valueUsesOf(constraint);
        if (previous === null || uses.length === 0) {
            return;
        }
        await this.eachPage(req, `popRelationship.id=${encodeURIComponent(String(previous['id']))}`, 'The price plans referencing the constraint cannot be retrieved', async (plans) => {
            const components: unknown[] = [];
            for (const plan of plans) {
                if (plan['isBundle'] !== true) {
                    continue;
                }
                const { ref, problem } = constraintRefOf(plan, null);
                if (problem !== undefined) {
                    throw refused(problem);
                }
                if (ref !== undefined && ref['id'] === previous['id'] && Array.isArray(plan['bundledPopRelationship'])) {
                    components.push(...(plan['bundledPopRelationship'] as unknown[]));
                }
            }
            await this.assertComponents(req, components, uses);
        });
    }

    // ---- What is read to check a price

    /** Each page of the prices that a filter finds, until there are no more; if the prices cannot be read the price is refused, as v11 did. */
    private async eachPage(req: Request, filter: string, failure: string, check: (page: Json[]) => Promise<void>): Promise<void> {
        for (let page = 0; page < this.config.limits.readAll.maxPages; page += 1) {
            const response = await this.proxy.send(req, { upstream: 'tmforum.catalog', path: '/productOfferingPrice', method: 'GET', search: `?${filter}&limit=${PAGE}&offset=${page * PAGE}` });
            const found = parseJson(response.body);
            if (response.status >= 400) {
                throw refused(failure);
            }
            const prices = (Array.isArray(found) ? (found as unknown[]) : []).filter(isRecord);
            await check(prices);
            if (prices.length < PAGE) {
                return;
            }
        }
        this.logger.warn(`The prices of ${filter} are more than the ones that can be read to check a price`);
        throw refused(failure);
    }

    /** The prices with those ids, by id; an id that is not one is not asked for, so the price is not found. */
    private async pricesById(req: Request, ids: unknown[], failure: string): Promise<Map<string, Json>> {
        const unique = [...new Set(ids.filter((id): id is string => typeof id === 'string' && isResourceId(id)))];
        const found = new Map<string, Json>();
        for (let from = 0; from < unique.length; from += BATCH) {
            const batch = unique.slice(from, from + BATCH);
            const response = await this.proxy.send(req, { upstream: 'tmforum.catalog', path: '/productOfferingPrice', method: 'GET', search: `?id=${batch.map(encodeURIComponent).join(',')}&limit=${batch.length}` });
            const prices = parseJson(response.body);
            if (response.status >= 400) {
                throw refused(failure);
            }
            for (const price of Array.isArray(prices) ? (prices as unknown[]) : []) {
                if (isRecord(price) && typeof price['id'] === 'string') {
                    found.set(price['id'], price);
                }
            }
        }
        return found;
    }
}
