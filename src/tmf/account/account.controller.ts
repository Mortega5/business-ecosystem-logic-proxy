import { All, Body, Controller, Get, Param, Patch, Post, Req, Res, UseInterceptors } from '@nestjs/common';
import type { Request, Response } from 'express';
import { BodyTextInterceptor } from '../body-text.interceptor';
import { DomainError, ForbiddenError, NotFoundError } from '../../common/domain-error';
import { AppConfigService } from '../../config/app-config.service';
import { JsonBodyPipe } from '../json-body.pipe';
import { OwnedResources, type OwnedRead } from '../owned-resources';
import { callerParty, isOwnedOnlyBy } from '../related-party';
import { ResourceIdPipe } from '../resource-id.pipe';
import { SellerParties } from '../seller-parties';
import { TmfProxy } from '../tmf-proxy';
import type { UpstreamUser } from '../upstream-headers';
import { parseBillingAccount, validateContacts } from './billing-account';

const NOT_THE_OWNER = 'The user making the request is not the specified owner';

/**
 * The account API, as far as the portal uses it: the billing accounts of the caller. An account is the caller's when they
 * are related to it as its owner, which is the seller role. Everything else under /account, a delete included, is closed
 * here.
 */
@UseInterceptors(BodyTextInterceptor)
@Controller('account')
export class AccountController {
    constructor(
        private readonly proxy: TmfProxy,
        private readonly owned: OwnedResources,
        private readonly config: AppConfigService,
        private readonly sellers: SellerParties
    ) {}

    private account(id: string): OwnedRead {
        return { upstream: 'tmforum.account', path: `/billingAccount/${encodeURIComponent(id)}`, noun: 'billing account', role: 'seller', refusal: NOT_THE_OWNER };
    }

    @Get('billingAccount')
    list(@Req() req: Request, @Res() res: Response): Promise<void> {
        return this.owned.list(req, res, {
            upstream: 'tmforum.account',
            path: '/billingAccount',
            role: 'seller',
            refusal: 'You are not authorized to list the billing accounts'
        });
    }

    @Get('billingAccount/:id')
    read(@Param('id', ResourceIdPipe) id: string, @Req() req: Request, @Res() res: Response): Promise<void> {
        return this.owned.read(req, res, this.account(id));
    }

    @Post('billingAccount')
    create(@Body(JsonBodyPipe) body: string, @Req() req: Request, @Res() res: Response): Promise<void> {
        const partyId = callerParty(req, NOT_THE_OWNER);
        const account = parseBillingAccount(body);
        if (!Array.isArray(account['relatedParty']) || account['relatedParty'].length === 0) {
            throw new DomainError('Missing relatedParty field', 400);
        }
        if (!isOwnedOnlyBy(account, partyId, this.config.auth.roles.seller)) {
            throw new ForbiddenError(NOT_THE_OWNER);
        }
        validateContacts(account);
        const [owner] = account['relatedParty'] as Record<string, unknown>[];
        account['relatedParty'] = this.sellers.of(owner as Record<string, unknown>, (req as Request & { user: UpstreamUser }).user);
        return this.proxy.forward(req, res, { upstream: 'tmforum.account', path: '/billingAccount', body: JSON.stringify(account) });
    }

    /** The account is read first, and only its owner changes it, and the owner cannot be changed to somebody else. */
    @Patch('billingAccount/:id')
    async update(@Param('id', ResourceIdPipe) id: string, @Body(JsonBodyPipe) body: string, @Req() req: Request, @Res() res: Response): Promise<void> {
        const partyId = callerParty(req, NOT_THE_OWNER);
        const changes = parseBillingAccount(body);
        const current = await this.owned.fetch(req, this.account(id));
        if (current.status >= 400) {
            this.proxy.reply(res, current);
            return;
        }
        if ('relatedParty' in changes && !isOwnedOnlyBy(changes, partyId, this.config.auth.roles.seller)) {
            throw new ForbiddenError(NOT_THE_OWNER);
        }
        validateContacts(changes);
        await this.proxy.forward(req, res, { upstream: 'tmforum.account', path: `/billingAccount/${encodeURIComponent(id)}`, body: JSON.stringify(changes) });
    }

    @All(['', '{*path}'])
    closed(): never {
        throw new NotFoundError('Not found');
    }
}
