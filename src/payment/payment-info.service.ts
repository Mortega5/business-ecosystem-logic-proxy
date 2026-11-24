import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { BadGatewayError, ForbiddenError } from '../common/domain-error';
import { AppConfigService } from '../config/app-config.service';
import type { UpstreamUser } from '../tmf/upstream-headers';

export interface PaymentInfo {
    gatewaysCount: number;
    providerUrl: string | null;
}

// The payment gateway is not one of the TMForum services, and it must not make the portal wait for long
const GATEWAY_TIMEOUT_MS = 10000;

/**
 * What the portal needs to know of how the party of the caller is paid. With the DPAS gateway it asks it how many payment gateways the
 * party has and for the address where the party manages them, which carries a token of the party when the gateway gives one; with the
 * other providers there is always one gateway and nothing to manage.
 */
@Injectable()
export class PaymentInfoService {
    constructor(
        private readonly config: AppConfigService,
        private readonly logger: PinoLogger
    ) {
        this.logger.setContext(PaymentInfoService.name);
    }

    async of(user: UpstreamUser): Promise<PaymentInfo> {
        const { paymentProvider, paymentGateway } = this.config.purchase;
        if (paymentProvider !== 'dpas' || paymentGateway === undefined) {
            return { gatewaysCount: 1, providerUrl: null };
        }
        const partyId = user.partyId;
        if (partyId === undefined || partyId === null || partyId === '') {
            throw new ForbiddenError('The user has no party to read the payment information of');
        }
        const gateway = paymentGateway.replace(/\/+$/, '');
        const [gatewaysCount, token] = await Promise.all([this.count(gateway, partyId), this.token(gateway, partyId, user.accessToken)]);
        // Without a token the party can still log in at the gateway, with its id
        const login = token === undefined ? `productProviderId=${encodeURIComponent(partyId)}` : `productProviderToken=${encodeURIComponent(token)}`;
        return { gatewaysCount, providerUrl: `${gateway}/provider-admin/#/login?${login}` };
    }

    private async count(gateway: string, partyId: string): Promise<number> {
        const text = await this.get(`${gateway}/api/product-providers/payment-gateways/count?productProviderExternalId=${encodeURIComponent(partyId)}`, {});
        const count = Number.parseInt(text ?? '', 10);
        if (!Number.isInteger(count) || count < 0) {
            this.logger.warn({ partyId }, 'The payment gateway did not answer a count');
            throw new BadGatewayError('The payment gateways could not be counted');
        }
        return count;
    }

    /** The token of the party at the gateway, asked for with the token of the user; undefined when the gateway does not give one. */
    private async token(gateway: string, partyId: string, userToken: string | undefined): Promise<string | undefined> {
        if (userToken === undefined || userToken === '') {
            return undefined;
        }
        try {
            const text = (await this.get(`${gateway}/api/product-providers/${encodeURIComponent(partyId)}/admin-token`, { authorization: `Bearer ${userToken}` }))?.trim();
            if (text === undefined || text === '') {
                return undefined;
            }
            // It comes as a JSON string or as the text itself
            try {
                const parsed: unknown = JSON.parse(text);
                return typeof parsed === 'string' && parsed !== '' ? parsed : undefined;
            } catch {
                return text;
            }
        } catch {
            this.logger.warn({ partyId }, 'The payment gateway did not give a token for the party');
            return undefined;
        }
    }

    private async get(url: string, headers: Record<string, string>): Promise<string | undefined> {
        try {
            const response = await fetch(url, { method: 'GET', headers, redirect: 'manual', signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS) });
            if (!response.ok) {
                this.logger.warn({ statusCode: response.status }, 'The payment gateway did not answer well');
                throw new BadGatewayError('The payment gateway did not answer');
            }
            return await response.text();
        } catch (error) {
            if (error instanceof BadGatewayError) {
                throw error;
            }
            this.logger.warn({ err: error }, 'The payment gateway could not be reached');
            throw new BadGatewayError('The payment gateway could not be reached');
        }
    }
}
