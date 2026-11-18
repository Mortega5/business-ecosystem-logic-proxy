import { All, Body, Controller, Delete, Get, Param, Patch, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { OptionalAuth } from '../../auth/public.decorator';
import { BadGatewayError, DomainError, ForbiddenError, NotFoundError } from '../../common/domain-error';
import { AppConfigService } from '../../config/app-config.service';
import { JsonBodyPipe } from '../json-body.pipe';
import { OwnedResources } from '../owned-resources';
import { callerParty, isOwnedOnlyBy, isRecord, isRelatedAs } from '../related-party';
import { ResourceIdPipe } from '../resource-id.pipe';
import { isInUse, isRetired, isValidStatusTransition, sameRelatedParties, validateNameAndDescription } from '../specification/specification-rules';
import { TmfProxy } from '../tmf-proxy';
import type { UpstreamUser } from '../upstream-headers';

const NOUN = 'Resource spec';
const NOT_THE_OWNER = 'Unauthorized to update non-owned/non-seller resource specs';
const PRODUCT_SPECIFICATIONS_PAGE = 100;
const MAX_PAGES = 50;

// What anybody may read; a specification in any other state, a draft, is for its owner
const PUBLIC_STATUSES = ['launched', 'retired', 'obsolete'];

const shown = (value: unknown): string => (typeof value === 'string' ? value : JSON.stringify(value));

/**
 * The resource specifications of the resource catalog, as far as the portal uses them. One that is launched, retired or obsolete
 * is read by anybody, as the product details show the ones a product has, and a draft only by its owner; the list is the caller's own, and a specification is created and changed only by a
 * seller who owns it. A retirement, by a change or by a delete, waits until every product specification that uses it is
 * retired. Everything else under /resource is closed here, so it is not handed to the legacy application.
 */
@Controller('resource')
export class ResourceController {
    constructor(
        private readonly proxy: TmfProxy,
        private readonly owned: OwnedResources,
        private readonly config: AppConfigService
    ) {}

    private path(id: string): string {
        return `/resourceSpecification/${encodeURIComponent(id)}`;
    }

    private isSeller(req: Request): boolean {
        const seller = this.config.auth.roles.seller.toLowerCase();
        return ((req as Request & { user?: UpstreamUser }).user?.roles ?? []).some((role) => role.name.toLowerCase() === seller);
    }

    @Get('resourceSpecification')
    list(@Req() req: Request, @Res() res: Response): Promise<void> {
        return this.owned.list(req, res, {
            upstream: 'tmforum.resource',
            path: '/resourceSpecification',
            role: 'seller',
            refusal: 'You are not authorized to list the resource specs'
        });
    }

    @OptionalAuth()
    @Get('resourceSpecification/:id')
    async read(@Param('id', ResourceIdPipe) id: string, @Req() req: Request, @Res() res: Response): Promise<void> {
        const response = await this.proxy.send(req, { upstream: 'tmforum.resource', path: this.path(id), search: '' });
        if (response.status < 400) {
            this.assertReadable(req, response.body);
        }
        this.proxy.reply(res, response);
    }

    @Post('resourceSpecification')
    create(@Body(JsonBodyPipe) body: string, @Req() req: Request, @Res() res: Response): Promise<void> {
        const specification = this.object(body);
        const refusal = 'Unauthorized to create non-owned/non-seller resource specs';
        if (!this.isSeller(req) || !isOwnedOnlyBy(specification, callerParty(req, refusal), this.config.auth.roles.seller)) {
            throw new ForbiddenError(refusal);
        }
        validateNameAndDescription(specification, NOUN, true);
        return this.proxy.forward(req, res, { upstream: 'tmforum.resource', path: '/resourceSpecification', body: JSON.stringify(specification) });
    }

    @Patch('resourceSpecification/:id')
    async update(@Param('id', ResourceIdPipe) id: string, @Body(JsonBodyPipe) body: string, @Req() req: Request, @Res() res: Response): Promise<void> {
        const changes = this.object(body);
        const current = await this.owner(req, id);
        if ('relatedParty' in changes && !sameRelatedParties(current['relatedParty'], changes['relatedParty'])) {
            throw new DomainError('The field "relatedParty" can not be modified', 409);
        }
        const status = changes['lifecycleStatus'];
        if (status !== undefined && status !== null) {
            if (!isValidStatusTransition(current['lifecycleStatus'], status)) {
                throw new DomainError(`Cannot transition from lifecycle status ${shown(current['lifecycleStatus'])} to ${shown(status)}`, 400);
            }
            if (!isRetired(current['lifecycleStatus']) && isRetired(status)) {
                await this.assertNotInUse(req, id);
            }
        }
        validateNameAndDescription(changes, NOUN, false);
        await this.proxy.forward(req, res, { upstream: 'tmforum.resource', path: this.path(id), body: JSON.stringify(changes) });
    }

    /** A delete retires the specification, which stays in the catalog. */
    @Delete('resourceSpecification/:id')
    async retire(@Param('id', ResourceIdPipe) id: string, @Req() req: Request, @Res() res: Response): Promise<void> {
        const current = await this.owner(req, id);
        if (isRetired(current['lifecycleStatus'])) {
            throw new DomainError('The resource is already retired', 409);
        }
        await this.assertNotInUse(req, id);
        await this.proxy.forward(req, res, {
            upstream: 'tmforum.resource',
            path: this.path(id),
            method: 'PATCH',
            body: JSON.stringify({ lifecycleStatus: 'Retired' }),
            contentType: 'application/json'
        });
    }

    private assertReadable(req: Request, body: string): void {
        let specification: unknown;
        try {
            specification = JSON.parse(body);
        } catch {
            specification = undefined;
        }
        if (!isRecord(specification)) {
            throw new BadGatewayError('The resource spec could not be read');
        }
        const status = specification['lifecycleStatus'];
        const partyId = (req as Request & { user?: UpstreamUser }).user?.partyId;
        if (
            (typeof status === 'string' && PUBLIC_STATUSES.includes(status.toLowerCase())) ||
            (typeof partyId === 'string' && isRelatedAs(specification, partyId, this.config.auth.roles.seller))
        ) {
            return;
        }
        throw new ForbiddenError('Unauthorized to read a resource spec that is not launched');
    }

    private object(body: string): Record<string, unknown> {
        const parsed: unknown = JSON.parse(body);
        if (!isRecord(parsed)) {
            throw new DomainError('Invalid body', 400);
        }
        return parsed;
    }

    /** The specification as the catalog has it, for a seller who owns it. */
    private async owner(req: Request, id: string): Promise<Record<string, unknown>> {
        const partyId = callerParty(req, NOT_THE_OWNER);
        const response = await this.proxy.send(req, { upstream: 'tmforum.resource', path: this.path(id), method: 'GET', search: '' });
        if (response.status === 404) {
            throw new NotFoundError('The required resource does not exist');
        }
        let current: unknown;
        try {
            current = JSON.parse(response.body);
        } catch {
            current = undefined;
        }
        if (response.status >= 400 || !isRecord(current)) {
            throw new BadGatewayError('The resource spec could not be read');
        }
        if (!this.isSeller(req) || !isRelatedAs(current, partyId, this.config.auth.roles.seller)) {
            throw new ForbiddenError(NOT_THE_OWNER);
        }
        return current;
    }

    private async assertNotInUse(req: Request, id: string): Promise<void> {
        for (let page = 0; page < MAX_PAGES; page += 1) {
            const search = `?resourceSpecification.id=${encodeURIComponent(id)}&fields=lifecycleStatus&limit=${PRODUCT_SPECIFICATIONS_PAGE}&offset=${page * PRODUCT_SPECIFICATIONS_PAGE}`;
            const response = await this.proxy.send(req, { upstream: 'tmforum.catalog', path: '/productSpecification', method: 'GET', search });
            let specifications: unknown;
            try {
                specifications = JSON.parse(response.body);
            } catch {
                specifications = undefined;
            }
            if (response.status >= 400 || !Array.isArray(specifications)) {
                throw new BadGatewayError('The product specs of the resource spec could not be read');
            }
            if (specifications.some(isInUse)) {
                throw new DomainError('Cannot retire a resource spec without retiring all product specs linked with it', 409);
            }
            if (specifications.length < PRODUCT_SPECIFICATIONS_PAGE) {
                return;
            }
        }
    }

    @All(['', '{*path}'])
    closed(): never {
        throw new NotFoundError('Not found');
    }
}
