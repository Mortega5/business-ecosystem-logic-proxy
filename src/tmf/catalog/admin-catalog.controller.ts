import { Body, Controller, Param, Patch, Req, Res, UseGuards, UseInterceptors } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AdministratorGuard } from '../administrator.guard';
import { BodyTextInterceptor } from '../body-text.interceptor';
import { JsonObjectBodyPipe } from '../json-body.pipe';
import { ResourceIdPipe } from '../resource-id.pipe';
import { Catalogs } from './catalogs';

/**
 * The catalogs as an administrator changes them, as far as the portal uses it: the name and the description of a catalog, which is how the
 * default catalog is edited. The other routes under /admin are not here and are not closed, so that the legacy application answers them.
 */
@UseInterceptors(BodyTextInterceptor)
@UseGuards(AdministratorGuard)
@Controller('admin/catalog')
export class AdminCatalogController {
    constructor(private readonly catalogs: Catalogs) {}

    @Patch('catalog/:id')
    update(@Param('id', ResourceIdPipe) id: string, @Body(JsonObjectBodyPipe) body: string, @Req() req: Request, @Res() res: Response): Promise<void> {
        return this.catalogs.updateAsAdministrator(req, res, id, body);
    }
}
