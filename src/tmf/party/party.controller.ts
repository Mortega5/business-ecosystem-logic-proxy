import { All, Body, Controller, Get, Param, Patch, Req, Res, UseInterceptors } from '@nestjs/common';
import type { Request, Response } from 'express';
import { BodyTextInterceptor } from '../body-text.interceptor';
import { OptionalAuth } from '../../auth/public.decorator';
import { z } from 'zod';
import { pagination, queryParams, sorting } from '../schemas/pagination';
import { parseRequest } from '../schemas/parse';
import { BadGatewayError, DomainError, ForbiddenError, NotFoundError } from '../../common/domain-error';
import { AppConfigService } from '../../config/app-config.service';
import { PRIVATE } from '../http-options';
import { JsonBodyPipe } from '../json-body.pipe';
import { isRecord } from '../related-party';
import { ResourceIdPipe } from '../resource-id.pipe';
import { TmfProxy } from '../tmf-proxy';
import type { UpstreamUser } from '../upstream-headers';
import { ProviderDirectory } from './provider-directory';
import { parsePartyChanges, validateOrganizationChanges } from './party-changes';

const NOT_ALLOWED = 'You are not allowed to access this resource';

// What an individual shows depends on who asks, so a cache in between must not give it to somebody else

// What the portal asks of the list of organisations; with `lifecycleStatus` or `keyword` it is the directory of providers
const organizationQuery = z.strictObject({
    fields: z.string().regex(/^[A-Za-z0-9_.@,-]{1,200}$/).optional(),
    ...pagination,
    lifecycleStatus: z.string().regex(/^launched$/i).optional(),
    keyword: z.string().regex(/^[^&;#]{1,200}$/).optional(),
    ...sorting(['tradingName'])
});

// What anybody who is logged in may know of another individual: the name that the portal shows
const PUBLIC_INDIVIDUAL = ['id', 'href', '@type', 'givenName', 'familyName'];

/**
 * The party API, as far as the portal uses it. The organisations are public, as the directory of providers and the offers
 * show them. An individual is read by a logged-in user, whole by themselves and only by name by anybody else, and a party
 * is changed only by itself. Everything else under /party, the list of individuals and the writes but the patch included,
 * is closed here.
 */
@UseInterceptors(BodyTextInterceptor)
@Controller('party')
export class PartyController {
    constructor(
        private readonly proxy: TmfProxy,
        private readonly config: AppConfigService,
        private readonly directory: ProviderDirectory
    ) {}

    private user(req: Request): UpstreamUser {
        const user = (req as Request & { user?: UpstreamUser }).user;
        if (user === undefined) {
            throw new ForbiddenError(NOT_ALLOWED);
        }
        return user;
    }

    @OptionalAuth()
    @Get('organization')
    list(@Req() req: Request, @Res() res: Response): Promise<void> {
        const params = queryParams(req.query, parseRequest(organizationQuery, req.query, 'Invalid query'));
        if (ProviderDirectory.isDirectoryQuery(params)) {
            return this.directory.list(req, res, params);
        }
        const search = params.size === 0 ? '' : `?${params.toString()}`;
        return this.proxy.forward(req, res, { upstream: 'tmforum.party', path: '/organization', search });
    }

    @OptionalAuth()
    @Get('organization/:id')
    readOrganization(@Param('id', ResourceIdPipe) id: string, @Req() req: Request, @Res() res: Response): Promise<void> {
        return this.proxy.forward(req, res, { upstream: 'tmforum.party', path: `/organization/${encodeURIComponent(id)}`, search: '' });
    }

    @Get('individual/:id')
    async readIndividual(@Param('id', ResourceIdPipe) id: string, @Req() req: Request, @Res() res: Response): Promise<void> {
        const user = this.user(req);
        const response = await this.proxy.send(req, { upstream: 'tmforum.party', path: `/individual/${encodeURIComponent(id)}`, search: '' });
        if (response.status >= 400 || id === user.partyId || id === user.userPartyId) {
            this.proxy.reply(res, response, PRIVATE);
            return;
        }
        let individual: unknown;
        try {
            individual = JSON.parse(response.body);
        } catch {
            throw new BadGatewayError('The individual could not be read');
        }
        if (!isRecord(individual)) {
            throw new BadGatewayError('The individual could not be read');
        }
        const name = Object.fromEntries(PUBLIC_INDIVIDUAL.filter((field) => field in individual).map((field) => [field, individual[field]]));
        this.proxy.reply(res, { ...response, body: JSON.stringify(name) }, PRIVATE);
    }

    @Patch('individual/:id')
    updateIndividual(@Param('id', ResourceIdPipe) id: string, @Body(JsonBodyPipe) body: string, @Req() req: Request, @Res() res: Response): Promise<void> {
        const changes = this.editable(body);
        const user = this.user(req);
        if (id !== user.partyId || this.actsForOrganization(user)) {
            throw new ForbiddenError(NOT_ALLOWED);
        }
        return this.proxy.forward(req, res, { upstream: 'tmforum.party', path: `/individual/${encodeURIComponent(id)}`, body: JSON.stringify(changes) });
    }

    @Patch('organization/:id')
    updateOrganization(@Param('id', ResourceIdPipe) id: string, @Body(JsonBodyPipe) body: string, @Req() req: Request, @Res() res: Response): Promise<void> {
        const changes = this.editable(body);
        const user = this.user(req);
        const orgAdmin = this.config.auth.roles.orgAdmin.toLowerCase();
        if (id !== user.partyId || !this.actsForOrganization(user) || !(user.roles ?? []).some((role) => role.name.toLowerCase() === orgAdmin)) {
            throw new ForbiddenError(NOT_ALLOWED);
        }
        validateOrganizationChanges(changes);
        return this.proxy.forward(req, res, { upstream: 'tmforum.party', path: `/organization/${encodeURIComponent(id)}`, body: JSON.stringify(changes) });
    }

    private editable(body: string): Record<string, unknown> {
        if (!this.config.party.editEnabled) {
            throw new ForbiddenError('Editing party info is disabled in this instance');
        }
        return parsePartyChanges(body);
    }

    // The user is logged in as an organisation when the individual behind it is known
    private actsForOrganization(user: UpstreamUser): boolean {
        return typeof user.userId === 'string' && user.userId !== '';
    }

    @All(['', '{*path}'])
    closed(): never {
        throw new NotFoundError('Not found');
    }
}
