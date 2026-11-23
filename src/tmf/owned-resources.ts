import { Injectable } from '@nestjs/common';
import type { Request, Response } from 'express';
import { DomainError, ForbiddenError } from '../common/domain-error';
import { AppConfigService } from '../config/app-config.service';
import type { UpstreamName } from '../config/upstream-names';
import type { UpstreamResponse } from '../http-client/upstream-client';
import { callerParty, isRelatedAs } from './related-party';
import { TmfProxy } from './tmf-proxy';

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

/** The role of the caller in the resource that makes it theirs. */
export type OwnerRole = 'customer' | 'seller';

export interface OwnedList {
    upstream: UpstreamName;
    path: string;
    /** The role that makes a resource the caller's; the customer by default. */
    role?: OwnerRole;
    /** The order of the list when the client asks for none, as the TMForum takes it: `-field` for the descending one. */
    defaultSort?: string;
    /** The refusal when the caller has no party; the inventory's by default. */
    refusal?: string;
}

export interface OwnedRead {
    upstream: UpstreamName;
    path: string;
    /** What the resource is called in the refusal. */
    noun: string;
    /** The role that makes the resource the caller's; the customer by default. */
    role?: OwnerRole;
    /** The whole refusal, when it is not the inventory's. */
    refusal?: string;
}

/**
 * Resources that belong to the parties related to them: a list is filtered for the caller and a resource is only
 * given to a party that is related to it in the role that makes it theirs.
 */
@Injectable()
export class OwnedResources {
    constructor(
        private readonly proxy: TmfProxy,
        private readonly config: AppConfigService
    ) {}

    /**
     * The list of the caller. Every filter the client sends goes on, except the ones about the related party, which the
     * proxy sets itself: the party of the caller and its role, last and next to each other, as the broker needs them.
     */
    async list(req: Request, res: Response, options: OwnedList): Promise<void> {
        await this.proxy.forward(req, res, { upstream: options.upstream, path: options.path, search: `?${this.query(req, options).toString()}` });
    }

    /** The query of a list of the caller: the filters of the client that are allowed, then the related party. */
    query(req: Request, options: OwnedList): URLSearchParams {
        const partyId = callerParty(req, options.refusal ?? 'You are not authorized to list the inventory');
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
        if (options.defaultSort !== undefined && !params.has('sort')) {
            params.append('sort', options.defaultSort);
        }
        params.append('relatedParty.id', partyId);
        params.append('relatedParty.role', this.config.auth.roles[options.role ?? 'customer']);
        return params;
    }

    /** One resource, given only when the caller is related to it in the role that makes it theirs. */
    async read(req: Request, res: Response, options: OwnedRead): Promise<void> {
        this.proxy.reply(res, await this.fetch(req, options));
    }

    /**
     * The resource as the upstream has it, for the caller to act on it: a success is returned only when the caller is
     * related to the resource in the role that makes it theirs, and any other answer is returned as it came.
     */
    async fetch(req: Request, options: OwnedRead): Promise<UpstreamResponse> {
        const refusal = options.refusal ?? `You are not authorized to retrieve the specified ${options.noun} from the inventory`;
        const partyId = callerParty(req, refusal);
        const response = await this.proxy.send(req, { upstream: options.upstream, path: options.path, method: 'GET', search: '' });
        if (response.status < 400 && !this.isRelated(partyId, response.body, options.role ?? 'customer')) {
            throw new ForbiddenError(refusal);
        }
        return response;
    }

    private isRelated(partyId: string, body: string, ownerRole: OwnerRole): boolean {
        try {
            return isRelatedAs(JSON.parse(body), partyId, this.config.auth.roles[ownerRole]);
        } catch {
            return false;
        }
    }
}
