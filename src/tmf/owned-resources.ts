import { Injectable } from '@nestjs/common';
import type { Request, Response } from 'express';
import { DomainError, ForbiddenError } from '../common/domain-error';
import { AppConfigService } from '../config/app-config.service';
import type { UpstreamName } from '../config/upstream-names';
import { TmfProxy } from './tmf-proxy';
import type { UpstreamUser } from './upstream-headers';

// A filter is any field of the resource, with an optional `*` for the regular expression form. The TMForum server splits
// a query on `&` and `;` even when they are encoded, so neither can be part of a name or a value.
const FILTER_NAME = /^[A-Za-z@][A-Za-z0-9_.@-]{0,79}\*?$/;
const FILTER_VALUE = /^[^&;]{0,500}$/;
const MAX_FILTERS = 20;

const hasControlCharacter = (value: string): boolean => {
    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        if (code < 0x20 || code === 0x7f) {
            return true;
        }
    }
    return false;
};

export interface OwnedList {
    upstream: UpstreamName;
    path: string;
}

export interface OwnedRead {
    upstream: UpstreamName;
    path: string;
    /** What the resource is called in the refusal. */
    noun: string;
}

/**
 * Resources that belong to the parties related to them: a list is filtered for the caller and a resource is only
 * given to a party that is related to it as a customer.
 */
@Injectable()
export class OwnedResources {
    constructor(
        private readonly proxy: TmfProxy,
        private readonly config: AppConfigService
    ) {}

    private partyOf(req: Request, what: string): string {
        const partyId = (req as Request & { user?: UpstreamUser }).user?.partyId;
        if (typeof partyId !== 'string' || partyId === '') {
            throw new ForbiddenError(what);
        }
        return partyId;
    }

    /**
     * The list of the caller. Every filter the client sends goes on, except the ones about the related party, which the
     * proxy sets itself: the party of the caller and its role, last and next to each other, as the broker needs them.
     */
    async list(req: Request, res: Response, options: OwnedList): Promise<void> {
        const partyId = this.partyOf(req, 'You are not authorized to list the inventory');
        const params = new URLSearchParams();
        const filters = Object.entries(req.query);
        if (filters.length > MAX_FILTERS) {
            throw new DomainError('Invalid query', 400);
        }
        for (const [name, value] of filters) {
            if (name.toLowerCase().includes('relatedparty')) {
                continue;
            }
            if (!FILTER_NAME.test(name) || name === 'q' || typeof value !== 'string' || !FILTER_VALUE.test(value) || hasControlCharacter(value)) {
                throw new DomainError('Invalid query', 400);
            }
            params.append(name, value);
        }
        params.append('relatedParty.id', partyId);
        params.append('relatedParty.role', this.config.auth.roles.customer);
        await this.proxy.forward(req, res, { upstream: options.upstream, path: options.path, search: `?${params.toString()}` });
    }

    /** One resource, given only when the caller is related to it as a customer. */
    async read(req: Request, res: Response, options: OwnedRead): Promise<void> {
        const refusal = `You are not authorized to retrieve the specified ${options.noun} from the inventory`;
        const partyId = this.partyOf(req, refusal);
        const response = await this.proxy.send(req, { upstream: options.upstream, path: options.path, search: '' });
        if (response.status < 400 && !this.isCustomer(partyId, response.body)) {
            throw new ForbiddenError(refusal);
        }
        this.proxy.reply(res, response);
    }

    private isCustomer(partyId: string, body: string): boolean {
        let resource: unknown;
        try {
            resource = JSON.parse(body);
        } catch {
            return false;
        }
        const parties = typeof resource === 'object' && resource !== null && !Array.isArray(resource) ? (resource as { relatedParty?: unknown }).relatedParty : undefined;
        const customer = this.config.auth.roles.customer.toLowerCase();
        return (
            Array.isArray(parties) &&
            parties.some((party: unknown) => {
                const { id, role } = (typeof party === 'object' && party !== null ? party : {}) as { id?: unknown; role?: unknown };
                return id === partyId && typeof role === 'string' && role.toLowerCase() === customer;
            })
        );
    }
}
