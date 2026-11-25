import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query, Res, UseGuards, UseInterceptors } from '@nestjs/common';
import type { Response } from 'express';
import { DomainError } from '../../common/domain-error';
import { BodyTextInterceptor } from '../../tmf/body-text.interceptor';
import { JsonObjectBodyPipe } from '../../tmf/json-body.pipe';
import { parseRequest } from '../../tmf/schemas/parse';
import { AdministratorGuard } from '../../tmf/administrator.guard';
import { IDP_ID, idpChangeForm, newIdpForm, type IdpView } from './idp-form';
import { IdpService } from './idp.service';

const idOf = (value: string): string => {
    if (!IDP_ID.test(value)) {
        throw new DomainError('Invalid IDP ID', 400);
    }
    return value;
};

/** The identity providers of the external login. Only for administrators: whoever adds one decides where users are sent to log in. */
@UseGuards(AdministratorGuard)
@UseInterceptors(BodyTextInterceptor)
@Controller('IDP')
export class IdpController {
    constructor(private readonly idps: IdpService) {}

    @Get()
    list(@Query('search') search?: string): Promise<IdpView[]> {
        return this.idps.list(typeof search === 'string' && search !== '' ? search : undefined);
    }

    @Get(':idpId')
    get(@Param('idpId') idpId: string): Promise<IdpView> {
        return this.idps.get(idOf(idpId));
    }

    @Post()
    @HttpCode(200)
    async create(@Body(JsonObjectBodyPipe) body: string, @Res({ passthrough: true }) res: Response): Promise<void> {
        const form = parseRequest(newIdpForm, JSON.parse(body), 'The identity provider is not correct');
        await this.idps.create(form);
        res.setHeader('location', `/IDP/${encodeURIComponent(form.idpId)}`);
    }

    @Put(':idpId')
    @HttpCode(200)
    async update(@Param('idpId') idpId: string, @Body(JsonObjectBodyPipe) body: string): Promise<void> {
        await this.idps.update(idOf(idpId), parseRequest(idpChangeForm, JSON.parse(body), 'The identity provider is not correct'));
    }

    @Delete(':idpId')
    @HttpCode(204)
    async remove(@Param('idpId') idpId: string): Promise<void> {
        await this.idps.remove(idOf(idpId));
    }
}
