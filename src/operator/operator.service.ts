import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { UpstreamClient } from '../http-client/upstream-client';

type Json = Record<string, unknown>;

const PARTY = 'tmforum.party' as const;
const RETRY_MS = 5000;
const REFRESH_MS = 24 * 60 * 60 * 1000;

/**
 * The operator of the marketplace: the organisation whose identifier is configured (`operator.id`, `did:elsi:` is added when it is not
 * a DID). It is looked for in the party API when the server starts, with retries until the API answers, and again every day, and
 * kept in memory. What a seller creates names it as a related party where it is configured.
 */
@Injectable()
export class OperatorService implements OnApplicationBootstrap, OnModuleDestroy {
    private readonly logger = new Logger(OperatorService.name);
    private id: string | undefined;
    private timer: NodeJS.Timeout | undefined;
    private stopped = false;

    constructor(
        private readonly config: AppConfigService,
        private readonly upstream: UpstreamClient
    ) {}

    onApplicationBootstrap(): void {
        if (this.configured() === '') {
            return;
        }
        void this.refresh();
    }

    onModuleDestroy(): void {
        this.stopped = true;
        clearTimeout(this.timer);
    }

    /** The operator as the related party of what a seller creates, or nothing when the marketplace has none. */
    seller(): Json | undefined {
        return this.as('sellerOperator');
    }

    /** The operator as the related party of what a buyer orders, or nothing when the marketplace has none. */
    buyer(): Json | undefined {
        return this.as('buyerOperator');
    }

    /** The operator as the owner of what the platform creates (its seller and its seller operator), or nothing when there is none. */
    owner(): Json[] | undefined {
        const owner = this.as('seller');
        const operator = this.as('sellerOperator');
        return owner === undefined || operator === undefined ? undefined : [owner, operator];
    }

    private configured(): string {
        return this.config.operator?.id ?? '';
    }

    private as(role: 'seller' | 'sellerOperator' | 'buyerOperator'): Json | undefined {
        if (this.id === undefined || this.id === '') {
            return undefined;
        }
        const roles = { seller: this.config.auth.roles.seller, sellerOperator: 'SellerOperator', buyerOperator: 'BuyerOperator' };
        return { id: this.id, href: this.id, name: this.configured(), role: roles[role], '@referredType': 'Organization' };
    }

    private async refresh(): Promise<void> {
        if (this.stopped) {
            return;
        }
        let delay = REFRESH_MS;
        try {
            this.id = await this.find();
            this.logger.log(this.id === '' ? 'The operator is not among the organizations' : 'Operator loaded');
        } catch (error) {
            // The id that was known stays until the party API answers
            delay = RETRY_MS;
            this.logger.error(`The operator could not be loaded, it is tried again: ${error instanceof Error ? error.message : 'unknown error'}`);
        }
        if (!this.stopped) {
            this.timer = setTimeout(() => void this.refresh(), delay);
            this.timer.unref();
        }
    }

    // By identification, by external reference with the DID, and by external reference as it was configured
    private async find(): Promise<string> {
        const configured = this.configured();
        const did = configured.startsWith('did:') ? configured : `did:elsi:${configured}`;
        for (const query of [{ 'organizationIdentification.identificationId': did }, { 'externalReference.name': did }, { 'externalReference.name': configured }]) {
            const found = await this.upstream.json<unknown>({ upstream: PARTY, path: '/organization', query });
            const first = Array.isArray(found) ? (found[0] as Json | undefined) : undefined;
            if (typeof first?.['id'] === 'string' && first['id'] !== '') {
                return first['id'];
            }
        }
        return '';
    }
}
