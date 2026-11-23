import { Injectable } from '@nestjs/common';
import type { Request, Response } from 'express';
import { BadGatewayError, DomainError, ForbiddenError, NotFoundError } from '../../common/domain-error';
import { AppConfigService } from '../../config/app-config.service';
import type { UpstreamName } from '../../config/upstream-names';
import type { UpstreamResponse } from '../../http-client/upstream-client';
import { LegacyOperator } from '../../legacy/legacy-operator';
import { AS_JSON, PRIVATE } from '../http-options';
import { OwnedResources } from '../owned-resources';
import { callerParty, isRecord, isRelatedAs } from '../related-party';
import { isResourceId } from '../resource-id.pipe';
import { parseJson } from '../specification/specifications';
import { TmfProxy } from '../tmf-proxy';
import type { UpstreamUser } from '../upstream-headers';
import { itemsWithStates, notesWith, orderState, sortedByDate } from './order-rules';

type Json = Record<string, unknown>;

const ORDERS = '/charging/api/orderManagement/orders';
// A bundle of offers is followed to the first offer of each bundle; this many bundles inside bundles is more than any catalog has
const MAX_BUNDLE_DEPTH = 10;
// What the charging backend says about the request itself, which the client is told as it is
const CLIENT_ERRORS = [400, 403, 409, 422];

const jsonOf = (text: string): unknown => parseJson(text);

const orderTime = (order: Json): number => (typeof order['orderDate'] === 'string' ? Date.parse(order['orderDate']) || 0 : 0);

/**
 * The product orders of the ordering API, as far as the portal uses them. An order is seen by the customer, who has all its items,
 * and by the sellers, who have the items of their own; a seller changes the state of their items and the state of the order follows
 * from them, a customer may cancel an order that nobody has started, and either of them adds notes. A new order is made with the
 * parties that the proxy finds, never the ones the client sends, and is notified to the charging backend, which says where to pay.
 */
@Injectable()
export class Orders {
    constructor(
        private readonly proxy: TmfProxy,
        private readonly owned: OwnedResources,
        private readonly config: AppConfigService,
        private readonly operator: LegacyOperator
    ) {}

    private get roles(): { seller: string; customer: string } {
        return this.config.auth.roles;
    }

    // ---- Reads

    /** The orders of the caller, as the customer or as the seller (when the client asks for that role). */
    async list(req: Request, res: Response): Promise<void> {
        const asked = req.query['relatedParty.role'];
        const role = typeof asked === 'string' && asked.toLowerCase() === this.roles.seller.toLowerCase() ? 'seller' : 'customer';
        const search = `?${this.owned.query(req, { upstream: 'tmforum.ordering', path: '/productOrder', role, refusal: 'You are not authorized to list the orders' }).toString()}`;
        const response = await this.proxy.send(req, { upstream: 'tmforum.ordering', path: '/productOrder', method: 'GET', search });
        const orders = jsonOf(response.body);
        if (response.status >= 400) {
            this.proxy.reply(res, response, PRIVATE);
            return;
        }
        if (!Array.isArray(orders)) {
            throw new BadGatewayError('The orders could not be read');
        }
        const partyId = callerParty(req, 'You are not authorized to list the orders');
        const shown = orders.filter(isRecord).flatMap((order): Json[] => {
            const seen = this.presented(order, partyId);
            return seen === undefined ? [] : [seen];
        });
        // The page is as the API sorted it when the client asked for a sort, and the newest first when it did not
        const sorted = req.query['sort'] === undefined ? shown.toSorted((a, b) => orderTime(b) - orderTime(a)) : shown;
        this.proxy.reply(res, { ...response, body: JSON.stringify(sorted) }, PRIVATE);
    }

    async read(req: Request, res: Response, id: string): Promise<void> {
        const partyId = callerParty(req, 'You are not authorized to retrieve the specified ordering');
        const response = await this.proxy.send(req, { upstream: 'tmforum.ordering', path: this.path(id), method: 'GET', search: '' });
        if (response.status >= 400) {
            this.proxy.reply(res, response, PRIVATE);
            return;
        }
        const order = jsonOf(response.body);
        if (!isRecord(order)) {
            throw new BadGatewayError('The order could not be read');
        }
        this.reply(res, response, this.visible(order, partyId));
    }

    private path(id: string): string {
        return `/productOrder/${encodeURIComponent(id)}`;
    }

    private reply(res: Response, response: UpstreamResponse, shown: Json, headers: Record<string, string> = {}): void {
        this.proxy.reply(res, { ...response, body: JSON.stringify(shown) }, { ...PRIVATE, ...headers });
    }

    /** The order as the party sees it: the customer has all of it, a seller the items that are theirs; nobody else sees it. */
    private presented(order: Json, partyId: string): Json | undefined {
        const customer = isRelatedAs(order, partyId, this.roles.customer);
        const seller = isRelatedAs(order, partyId, this.roles.seller);
        if (!customer && !seller) {
            return undefined;
        }
        const items = Array.isArray(order['productOrderItem']) ? order['productOrderItem'].filter(isRecord) : [];
        const shown = customer ? items : items.filter((item) => isRelatedAs(item['product'], partyId, this.roles.seller));
        return { ...order, productOrderItem: shown, note: sortedByDate(order['note']) };
    }

    private visible(order: Json, partyId: string): Json {
        const shown = this.presented(order, partyId);
        if (shown === undefined) {
            throw new ForbiddenError('You are not authorized to retrieve the specified ordering');
        }
        return shown;
    }

    // ---- Create

    async create(req: Request, res: Response, text: string): Promise<void> {
        const user = (req as Request & { user: UpstreamUser }).user;
        const partyId = callerParty(req, 'You are not authorized to order products');
        const body = JSON.parse(text) as Json;
        const parties = body['relatedParty'];
        if (!Array.isArray(parties)) {
            throw new DomainError('A product order must contain a relatedParty field', 400);
        }
        const customers = parties.filter((party): party is Json => isRecord(party) && String(party['role']).toLowerCase() === this.roles.customer.toLowerCase());
        if (customers.length === 0) {
            throw new ForbiddenError('It is required to specify a customer in the relatedParty field');
        }
        if (customers.some((customer) => customer['id'] !== partyId)) {
            throw new ForbiddenError('The customer specified in the product order is not the user making the request');
        }
        const sent = body['productOrderItem'];
        if (!Array.isArray(sent) || sent.length === 0) {
            throw new DomainError('A product order must contain an productOrderItem field', 400);
        }
        if (sent.length > this.config.limits.orderItems || !sent.every(isRecord)) {
            throw new DomainError('The product order items are not valid', 400);
        }

        const customer = { id: partyId, role: this.roles.customer, href: this.partyUrl(req, user) };
        const sellersOfItem = await Promise.all(sent.map((item) => this.sellersOf(req, item, partyId)));
        const sellers = [...new Set(sellersOfItem.flat())];
        if (sellers.includes(partyId)) {
            throw new ForbiddenError('You cannot acquire your own offering');
        }
        const billingAccount = await this.billingAccountOf(req, body['billingAccount'], partyId);

        const items = sent.map((item, index) => {
            const { state: _state, ...rest } = item;
            const product = { ...(rest['product'] as Json), relatedParty: [customer, ...(sellersOfItem[index] ?? []).map((id) => ({ id, href: id, role: this.roles.seller }))] };
            return { ...rest, product };
        });
        // The state, the notes and the identity of an order are the API's to give
        const { id: _id, href: _href, state: _orderState, note: _note, orderDate: _orderDate, ...rest } = body;
        const order = { ...rest, productOrderItem: items, billingAccount, relatedParty: await this.orderParties(req, user, sellers) };

        const created = await this.proxy.send(req, { upstream: 'tmforum.ordering', path: '/productOrder', method: 'POST', body: JSON.stringify(order), ...AS_JSON, search: '' });
        const stored = jsonOf(created.body);
        if (created.status >= 400) {
            this.proxy.reply(res, created, PRIVATE);
            return;
        }
        if (!isRecord(stored) || typeof stored['id'] !== 'string') {
            throw new BadGatewayError('The order was created but its answer could not be read');
        }
        const redirect = await this.notifyCreated(req, created.body, stored['id']);
        this.proxy.reply(res, created, { ...PRIVATE, ...(redirect === undefined ? {} : { 'x-redirect-url': redirect }) });
    }

    /** The address of the party of the caller in this proxy, as v11 wrote it in the product of an item. */
    private partyUrl(req: Request, user: UpstreamUser): string {
        const kind = user.userId != null && user.userId !== user.partyId ? 'organization' : 'individual';
        return `${req.secure ? 'https' : 'http'}://${req.hostname}:${this.config.app.port}/party/${kind}/${String(user.partyId)}`;
    }

    /** A resource of an upstream: what the client is told when it cannot be had is `failure`, as a 404 when it is not there and `missing` says so. */
    private async readJson(req: Request, upstream: UpstreamName, path: string, failure: string, missing = false): Promise<Json> {
        const response = await this.proxy.send(req, { upstream, path, method: 'GET', search: '' });
        const found = jsonOf(response.body);
        if (response.status === 404 && missing) {
            throw new NotFoundError(failure);
        }
        if (response.status >= 400 || !isRecord(found)) {
            // A refusal of the API is about what the client asked for; an answer that is not one is a failure of the API
            throw new DomainError(failure, response.status >= 400 && response.status < 500 ? 400 : 502);
        }
        return found;
    }

    /** The sellers of what an item orders: the ones of its offer, or of its product specification when the offer has none. */
    private async sellersOf(req: Request, item: Json, partyId: string): Promise<string[]> {
        const label = String(item['id']);
        const { product, productOffering } = item;
        if (!isRecord(product)) {
            throw new DomainError(`The product order item ${label} must contain a product field`, 400);
        }
        if (!isRecord(productOffering)) {
            throw new DomainError(`The product order item ${label} must contain a productOffering field`, 400);
        }
        if (Array.isArray(product['relatedParty']) && product['relatedParty'].some((party) => isRecord(party) && String(party['role']).toLowerCase() === this.roles.customer.toLowerCase() && party['id'] !== partyId)) {
            throw new ForbiddenError(`The customer specified in the order item ${label} is not the user making the request`);
        }
        return [...new Set(await this.offeringSellers(req, productOffering['id'], label, partyId, 0))];
    }

    private async offeringSellers(req: Request, offeringId: unknown, label: string, partyId: string, depth: number): Promise<string[]> {
        const failure = `The system fails to retrieve the offering attached to the ordering item ${label}`;
        if (typeof offeringId !== 'string' || !isResourceId(offeringId) || depth > MAX_BUNDLE_DEPTH) {
            throw new DomainError(failure, 400);
        }
        const offering = await this.readJson(req, 'tmforum.catalog', `/productOffering/${encodeURIComponent(offeringId)}`, failure);
        const parties = offering['relatedParty'];
        if (Array.isArray(parties) && parties.length > 0) {
            // An offer for a buyer is only ordered by that buyer
            const buyers = parties.filter((party): party is Json => isRecord(party) && String(party['role']).toLowerCase() === this.roles.customer.toLowerCase());
            if (buyers.length > 0 && !buyers.some((buyer) => buyer['id'] === partyId)) {
                throw new ForbiddenError('The buyer specified in the product offering is not the user making the request');
            }
            return this.sellerIds(parties);
        }
        if (offering['isBundle'] !== true) {
            const specification = offering['productSpecification'];
            const specificationId = isRecord(specification) ? specification['id'] : undefined;
            if (typeof specificationId !== 'string' || !isResourceId(specificationId)) {
                throw new DomainError(`The system fails to retrieve the product attached to the ordering item ${label}`, 400);
            }
            const spec = await this.readJson(req, 'tmforum.catalog', `/productSpecification/${encodeURIComponent(specificationId)}`, `The system fails to retrieve the product attached to the ordering item ${label}`);
            const owners = this.sellerIds(spec['relatedParty']);
            if (owners.length === 0) {
                throw new DomainError('You cannot order a product without owners', 400);
            }
            return owners;
        }
        const bundled = offering['bundledProductOffering'];
        const first = Array.isArray(bundled) && isRecord(bundled[0]) ? bundled[0]['id'] : undefined;
        return this.offeringSellers(req, first, label, partyId, depth + 1);
    }

    private sellerIds(parties: unknown): string[] {
        const seller = this.roles.seller.toLowerCase();
        return (Array.isArray(parties) ? parties : []).flatMap((party) => (isRecord(party) && typeof party['id'] === 'string' && String(party['role']).toLowerCase() === seller ? [party['id']] : []));
    }

    private async billingAccountOf(req: Request, sent: unknown, partyId: string): Promise<Json> {
        const id = isRecord(sent) ? sent['id'] : undefined;
        if (typeof id !== 'string' || id === '') {
            throw new DomainError('Billing Account is required', 422);
        }
        if (!isResourceId(id)) {
            throw new DomainError('Invalid billing account id', 422);
        }
        const response = await this.proxy.send(req, { upstream: 'tmforum.account', path: `/billingAccount/${encodeURIComponent(id)}`, method: 'GET', search: '' });
        const account = jsonOf(response.body);
        if (response.status >= 400 || !isRecord(account)) {
            throw new DomainError('Invalid billing account id', 422);
        }
        const related = Array.isArray(account['relatedParty']) && account['relatedParty'].some((party) => isRecord(party) && party['id'] === partyId);
        if (!related) {
            throw new DomainError('Cannot find the specified billing account for this user', 422);
        }
        // What is sent on is the account that was checked, by its id; the client's own href is not
        return { id, href: id };
    }

    /** The related parties of an order as v11 wrote them: each seller, the operator as their seller, the buyer, and the operator as buyer. */
    private async orderParties(req: Request, user: UpstreamUser, sellers: string[]): Promise<Json[]> {
        const partyId = String(user.partyId);
        const normalizedSellers = await Promise.all(sellers.map((id) => this.normalized(req, user, { id, href: id, role: this.roles.seller })));
        const buyer = await this.normalized(req, user, { id: partyId, href: partyId, role: this.roles.customer });
        return [
            ...normalizedSellers,
            ...(this.operator.seller() === undefined ? [] : [this.operator.seller() as Json]),
            buyer,
            ...(this.operator.buyer() === undefined ? [] : [this.operator.buyer() as Json])
        ];
    }

    private async normalized(req: Request, user: UpstreamUser, party: { id: string; href: string; role: string }): Promise<Json> {
        const organization = party.id.includes('organization');
        let name = '';
        if (party.id === user.partyId) {
            name = user.id;
        } else {
            if (!isResourceId(party.id)) {
                throw new BadGatewayError('The seller of an offering is not valid');
            }
            const found = await this.readJson(req, 'tmforum.party', `/${organization ? 'organization' : 'individual'}/${encodeURIComponent(party.id)}`, `The party ${party.id} could not be read`);
            const references = Array.isArray(found['externalReference']) ? found['externalReference'] : [];
            const reference: unknown = references.find((candidate) => isRecord(candidate) && typeof candidate['externalReferenceType'] === 'string' && candidate['externalReferenceType'].toLowerCase() === 'idm_id');
            name = isRecord(reference) && typeof reference['name'] === 'string' ? reference['name'] : '';
        }
        return { id: party.id, href: party.href, name, role: party.role, '@referredType': organization ? 'Organization' : 'Individual' };
    }

    /** Tells the charging backend about an order that was made, with the terms that the buyer accepted; it answers where to pay, if anywhere. */
    private async notifyCreated(req: Request, order: string, id: string): Promise<string | undefined> {
        const accepted = req.headers['x-terms-accepted'];
        const headers = typeof accepted === 'string' && accepted.toLowerCase() === 'true' ? { 'X-Terms-Accepted': 'True' } : undefined;
        try {
            const response = await this.charging(req, ORDERS, order, 'The server has failed processing your order', headers);
            const answer = jsonOf(response.body);
            return isRecord(answer) && typeof answer['redirectUrl'] === 'string' ? answer['redirectUrl'] : undefined;
        } catch (error) {
            // The order exists in the ordering API, so the client is told what is left
            if (error instanceof DomainError) {
                throw new DomainError(`${error.message}. The order ${id} was created and was not processed`, error.status === 504 ? 502 : error.status);
            }
            throw error;
        }
    }

    /** A call to the charging backend; what it says about the request goes to the client, and any other failure is a bad gateway. */
    private async charging(req: Request, path: string, body: string, failure: string, headers?: Record<string, string>): Promise<UpstreamResponse> {
        const response = await this.proxy.send(req, { upstream: 'charging', path, method: 'POST', body, ...AS_JSON, search: '', ...(headers === undefined ? {} : { headers }) });
        if (response.status < 400) {
            return response;
        }
        const said = jsonOf(response.body);
        if (CLIENT_ERRORS.includes(response.status)) {
            throw new DomainError(isRecord(said) && typeof said['error'] === 'string' ? said['error'] : failure, response.status);
        }
        throw new BadGatewayError(failure);
    }

    // ---- Update

    async update(req: Request, res: Response, id: string, text: string): Promise<void> {
        const partyId = callerParty(req, 'You are not authorized to modify this order');
        const changes = JSON.parse(text) as Json;
        const previous = await this.readJson(req, 'tmforum.ordering', this.path(id), 'The requested ordering cannot be retrieved', true);
        const items = Array.isArray(previous['productOrderItem']) ? previous['productOrderItem'].filter(isRecord) : [];
        if (isRelatedAs(previous, partyId, this.roles.customer)) {
            return this.customerUpdate(req, res, id, previous, items, changes, partyId);
        }
        if (isRelatedAs(previous, partyId, this.roles.seller)) {
            return this.sellerUpdate(req, res, id, previous, items, changes, partyId);
        }
        throw new ForbiddenError('You are not authorized to modify this order');
    }

    private async customerUpdate(req: Request, res: Response, id: string, previous: Json, items: Json[], changes: Json, partyId: string): Promise<void> {
        const fields = Object.keys(changes);
        if ('relatedParty' in changes) {
            throw new ForbiddenError('Related parties cannot be modified');
        }
        if ('productOrderItem' in changes) {
            throw new ForbiddenError('Order items can only be modified by sellers');
        }
        if (fields.length !== 1 || (fields[0] !== 'state' && fields[0] !== 'note')) {
            throw new ForbiddenError('Customers can only cancel an order or add notes');
        }
        if (fields[0] === 'note') {
            return this.addNotes(req, res, id, previous, changes['note'], partyId);
        }
        if (typeof changes['state'] !== 'string' || changes['state'].toLowerCase() !== 'cancelled') {
            throw new ForbiddenError('Invalid order state. Valid states for customers are: "cancelled"');
        }
        // An order is cancelled while nobody has started it
        if (items.length === 0 || !items.every((item) => typeof item['state'] === 'string' && item['state'].toLowerCase() === 'acknowledged')) {
            throw new ForbiddenError('Orderings can only be cancelled when all Order items are in Acknowledged state');
        }
        await this.charging(req, `${ORDERS}/refund`, JSON.stringify({ orderId: id }), 'The server has failed at the time of refunding the order');
        const cancelled = items.map((item) => ({ ...item, state: 'cancelled' }));
        const left = `The order ${id} was refunded and could not be cancelled`;
        let response: UpstreamResponse;
        try {
            response = await this.proxy.send(req, { upstream: 'tmforum.ordering', path: this.path(id), body: JSON.stringify({ state: 'cancelled', productOrderItem: cancelled }), ...AS_JSON, search: '' });
        } catch {
            throw new BadGatewayError(left);
        }
        if (response.status >= 400) {
            throw new BadGatewayError(left);
        }
        this.answer(res, response, partyId);
    }

    private async sellerUpdate(req: Request, res: Response, id: string, previous: Json, items: Json[], changes: Json, partyId: string): Promise<void> {
        const fields = Object.keys(changes);
        if (fields.length !== 1 || (fields[0] !== 'productOrderItem' && fields[0] !== 'note')) {
            throw new ForbiddenError('Sellers can only modify order items or include notes');
        }
        if (fields[0] === 'note') {
            return this.addNotes(req, res, id, previous, changes['note'], partyId);
        }
        const updated = itemsWithStates(items, changes['productOrderItem'], (item) => isRelatedAs(item['product'], partyId, this.roles.seller));
        const state = orderState(updated);
        const response = await this.proxy.send(req, {
            upstream: 'tmforum.ordering',
            path: this.path(id),
            body: JSON.stringify({ productOrderItem: updated, ...(state === undefined ? {} : { state }) }),
            ...AS_JSON,
            search: ''
        });
        if (response.status < 400 && state === 'completed') {
            await this.notifyCompleted(req, id);
        }
        this.answer(res, response, partyId);
    }

    /** The charging backend creates what was bought when the order is completed; when it cannot, the seller has to send the state again. */
    private async notifyCompleted(req: Request, id: string): Promise<void> {
        try {
            await this.charging(req, `${ORDERS}/completed/${encodeURIComponent(id)}`, '{}', 'The server has failed processing your order');
        } catch (error) {
            const reason = error instanceof DomainError ? error.message : 'The server has failed processing your order';
            throw new BadGatewayError(`The order ${id} was completed and the charging backend could not be notified: ${reason}. Send the state again to notify it`);
        }
    }

    private async addNotes(req: Request, res: Response, id: string, previous: Json, sent: unknown, partyId: string): Promise<void> {
        const note = notesWith(previous['note'], sent, partyId, new Date(), this.config.limits);
        const response = await this.proxy.send(req, { upstream: 'tmforum.ordering', path: this.path(id), body: JSON.stringify({ note }), ...AS_JSON, search: '' });
        this.answer(res, response, partyId);
    }

    /** The answer of a change, which is the order as the caller sees it. */
    private answer(res: Response, response: UpstreamResponse, partyId: string): void {
        const order = jsonOf(response.body);
        if (response.status >= 400 || !isRecord(order)) {
            this.proxy.reply(res, response, PRIVATE);
            return;
        }
        this.reply(res, response, this.visible(order, partyId));
    }
}
