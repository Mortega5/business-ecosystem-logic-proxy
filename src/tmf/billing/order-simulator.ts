import { Injectable, Logger } from '@nestjs/common';
import type { Request } from 'express';
import { BadGatewayError, DomainError, ForbiddenError } from '../../common/domain-error';
import { AppConfigService } from '../../config/app-config.service';
import { UpstreamClient, UpstreamError, type UpstreamResponse } from '../../http-client/upstream-client';
import { callerParty, isRecord } from '../related-party';
import { type OrderSimulation } from '../schemas/order-simulation';
import { TmfProxy } from '../tmf-proxy';

const NO_ACCOUNT = 'Cannot find the specified billing account for this user';

const asList = (value: unknown): unknown[] => (Array.isArray(value) ? (value as unknown[]) : []);

/**
 * Prices an order in the billing engine. The parties of the order are not the client's: the customer is the caller and the
 * sellers are those of the specifications of its offerings; the billing account is one of the caller's. The engine gets no
 * credential of the user, and what it answers with an error of its own is not passed on.
 */
@Injectable()
export class OrderSimulator {
    private readonly logger = new Logger(OrderSimulator.name);

    constructor(
        private readonly proxy: TmfProxy,
        private readonly upstream: UpstreamClient,
        private readonly config: AppConfigService
    ) {}

    async simulate(req: Request, order: OrderSimulation): Promise<UpstreamResponse> {
        if (!this.config.hasUpstream('billingEngine')) {
            throw new DomainError('The price simulator is not available', 503);
        }
        const partyId = callerParty(req, 'You are not authorized to simulate an order');
        const roles = this.config.auth.roles;
        const { productOrder } = order;
        const sellers = await this.sellersOf(
            req,
            productOrder.productOrderItem.map((item) => item.productOffering.id)
        );
        const billingAccount = await this.billingAccount(req, partyId, productOrder.billingAccount);
        const priced = {
            ...order,
            productOrder: {
                ...productOrder,
                billingAccount,
                relatedParty: [
                    { id: partyId, role: roles.customer, href: partyId, '@referredType': 'organization' },
                    ...sellers.map((id) => ({ id, role: roles.seller, href: id, '@referredType': 'organization' }))
                ]
            }
        };
        try {
            const response = await this.upstream.send({
                upstream: 'billingEngine',
                path: '',
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(priced)
            });
            this.logger.log({ items: productOrder.productOrderItem.length, statusCode: response.status }, 'An order was priced');
            if (response.status >= 500) {
                throw new BadGatewayError('The price simulator failed');
            }
            return response;
        } catch (error) {
            if (error instanceof UpstreamError) {
                this.logger.warn({ err: error }, 'The billing engine could not be reached');
                throw new BadGatewayError('The price simulator is not reachable');
            }
            throw error;
        }
    }

    private async read(req: Request, upstream: 'tmforum.catalog' | 'tmforum.account', path: string): Promise<unknown> {
        const response = await this.proxy.send(req, { upstream, path, method: 'GET', search: '' });
        if (response.status >= 400) {
            return undefined;
        }
        try {
            return JSON.parse(response.body);
        } catch {
            return undefined;
        }
    }

    /** The sellers of every offering of the order, once each; an offering that cannot be read refuses the order. */
    private async sellersOf(req: Request, offeringIds: string[]): Promise<string[]> {
        const sellers = new Set<string>();
        const seller = this.config.auth.roles.seller.toLowerCase();
        for (const offeringId of new Set(offeringIds)) {
            const offering = await this.read(req, 'tmforum.catalog', `/productOffering/${encodeURIComponent(offeringId)}`);
            const specId = isRecord(offering) && isRecord(offering['productSpecification']) ? offering['productSpecification']['id'] : undefined;
            const spec = typeof specId === 'string' ? await this.read(req, 'tmforum.catalog', `/productSpecification/${encodeURIComponent(specId)}`) : undefined;
            if (!isRecord(spec)) {
                this.logger.warn({ offeringId }, 'The seller of an offering of the order could not be read');
                throw new DomainError('Error retrieving parties', 400);
            }
            for (const party of asList(spec['relatedParty'])) {
                if (isRecord(party) && typeof party['id'] === 'string' && typeof party['role'] === 'string' && party['role'].toLowerCase() === seller) {
                    sellers.add(party['id']);
                }
            }
        }
        return [...sellers];
    }

    /** The account the order names, which must be one of the caller, or else their preferred one for postal addresses. */
    private async billingAccount(req: Request, partyId: string, named: { id: string } | undefined): Promise<Record<string, unknown>> {
        if (named !== undefined) {
            const account = await this.read(req, 'tmforum.account', `/billingAccount/${encodeURIComponent(named.id)}`);
            if (!isRecord(account)) {
                throw new DomainError('Invalid billing account id', 400);
            }
            if (!asList(account['relatedParty']).some((party) => isRecord(party) && party['id'] === partyId)) {
                throw new ForbiddenError(NO_ACCOUNT);
            }
            return { ...named, resolved: account };
        }
        const query = new URLSearchParams({ 'relatedParty.id': partyId });
        const response = await this.proxy.send(req, { upstream: 'tmforum.account', path: '/billingAccount', method: 'GET', search: `?${query.toString()}` });
        if (response.status >= 400) {
            throw new DomainError('Error searching for preferred billing address', 400);
        }
        let accounts: unknown;
        try {
            accounts = JSON.parse(response.body);
        } catch {
            accounts = undefined;
        }
        return { resolved: asList(accounts).find(hasPreferredAddress) ?? null };
    }
}

const hasPreferredAddress = (account: unknown): boolean => {
    if (!isRecord(account)) {
        return false;
    }
    const contact = asList(account['contact'])[0];
    return (
        isRecord(contact) &&
        asList(contact['contactMedium']).some((medium) => isRecord(medium) && medium['preferred'] === true && medium['mediumType'] === 'PostalAddress')
    );
};
