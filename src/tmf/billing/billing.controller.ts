import { All, Body, Controller, Get, Param, Patch, Req, Res, UseInterceptors } from '@nestjs/common';
import type { Request, Response } from 'express';
import { BodyTextInterceptor } from '../body-text.interceptor';
import { ForbiddenError, NotFoundError } from '../../common/domain-error';
import { AppConfigService } from '../../config/app-config.service';
import type { UpstreamResponse } from '../../http-client/upstream-client';
import { JsonObjectBodyPipe } from '../json-body.pipe';
import { OwnedResources, type OwnerRole } from '../owned-resources';
import { callerParty, isRelatedAs } from '../related-party';
import { ResourceIdPipe } from '../resource-id.pipe';
import { billRenaming, ratesQuery } from '../schemas/customer-bill';
import { pageParams } from '../schemas/pagination';
import { parseRequest } from '../schemas/parse';
import { TmfProxy } from '../tmf-proxy';

const UPSTREAM = 'tmforum.customerBill';
const NOT_INVOLVED = 'You are not authorized to access the specified bill';

/**
 * The billing API, as far as the portal uses it: the bills of the caller, a bill, the name of a bill, and the rates applied
 * to a bill. A bill is the caller's when they are related to it, as its customer or as its seller. Everything else under
 * /billing is closed here, so it is not handed to the legacy application.
 */
@UseInterceptors(BodyTextInterceptor)
@Controller('billing')
export class BillingController {
    constructor(
        private readonly proxy: TmfProxy,
        private readonly owned: OwnedResources,
        private readonly config: AppConfigService
    ) {}

    /** The bills of the caller in the role they ask for, the customer by default; any other role is refused. */
    @Get('customerBill')
    list(@Req() req: Request, @Res() res: Response): Promise<void> {
        return this.owned.list(req, res, { upstream: UPSTREAM, path: '/customerBill', role: this.roleOf(req), refusal: 'You are not authorized to list the bills' });
    }

    @Get('customerBill/:id')
    async read(@Param('id', ResourceIdPipe) id: string, @Req() req: Request, @Res() res: Response): Promise<void> {
        this.proxy.reply(res, await this.bill(req, id));
    }

    /** Only the name of the bill, which is what the portal lets its parties change, and only by a party of the bill. */
    @Patch('customerBill/:id')
    async rename(@Param('id', ResourceIdPipe) id: string, @Body(JsonObjectBodyPipe) body: string, @Req() req: Request, @Res() res: Response): Promise<void> {
        const changes = parseRequest(billRenaming(this.config.limits.nameLength), JSON.parse(body), `Only the billNo of a bill can be changed, and it must be a text of up to ${this.config.limits.nameLength} characters`);
        const current = await this.bill(req, id);
        if (current.status >= 400) {
            this.proxy.reply(res, current);
            return;
        }
        await this.proxy.forward(req, res, { upstream: UPSTREAM, path: `/customerBill/${encodeURIComponent(id)}`, body: JSON.stringify(changes) });
    }

    /** The rates of one bill, given to a party of that bill; the only filters are the bill and the page. */
    @Get('appliedCustomerBillingRate')
    async rates(@Req() req: Request, @Res() res: Response): Promise<void> {
        const query = parseRequest(ratesQuery, req.query, 'Invalid query params for appliedCustomerBillingRate');
        const billId = query['bill.id'];
        const params = new URLSearchParams([['bill.id', billId], ...pageParams(query)]);
        const current = await this.bill(req, billId);
        if (current.status >= 400) {
            this.proxy.reply(res, current);
            return;
        }
        await this.proxy.forward(req, res, { upstream: UPSTREAM, path: '/appliedCustomerBillingRate', search: `?${params.toString()}` });
    }

    @All(['', '{*path}'])
    closed(): never {
        throw new NotFoundError('Not found');
    }

    private roleOf(req: Request): OwnerRole {
        const asked = req.query['relatedParty.role'];
        if (asked === undefined) {
            return 'customer';
        }
        const roles = this.config.auth.roles;
        const wanted = typeof asked === 'string' ? asked.toLowerCase() : '';
        if (wanted === roles.customer.toLowerCase()) {
            return 'customer';
        }
        if (wanted === roles.seller.toLowerCase()) {
            return 'seller';
        }
        throw new ForbiddenError('You are not allowed to filter parties using the specified role');
    }

    /** The bill as the upstream has it, for the caller to act on it: a success only when the caller is a party of the bill. */
    private async bill(req: Request, id: string): Promise<UpstreamResponse> {
        const partyId = callerParty(req, NOT_INVOLVED);
        const response = await this.proxy.send(req, { upstream: UPSTREAM, path: `/customerBill/${encodeURIComponent(id)}`, method: 'GET', search: '' });
        if (response.status < 400 && !this.involves(partyId, response.body)) {
            throw new ForbiddenError(NOT_INVOLVED);
        }
        return response;
    }

    private involves(partyId: string, body: string): boolean {
        try {
            const bill: unknown = JSON.parse(body);
            const roles = this.config.auth.roles;
            return isRelatedAs(bill, partyId, roles.customer) || isRelatedAs(bill, partyId, roles.seller);
        } catch {
            return false;
        }
    }
}
