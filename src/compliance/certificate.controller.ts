import { All, Body, Controller, HttpCode, Param, Patch, Req, UseInterceptors } from '@nestjs/common';
import type { Request } from 'express';
import { NotFoundError } from '../common/domain-error';
import { BodyTextInterceptor } from '../tmf/body-text.interceptor';
import { JsonObjectBodyPipe } from '../tmf/json-body.pipe';
import { ResourceIdPipe } from '../tmf/resource-id.pipe';
import { RequireFeature } from '../features/require-feature';
import { CertificateService } from './certificate.service';

/**
 * The credential of a product, for administrators and certifiers. It is under /admin, where the core closes only the routes it serves
 * itself, so this closes just its own prefix.
 */
@RequireFeature('compliance')
@UseInterceptors(BodyTextInterceptor)
@Controller('admin/uploadcertificate')
export class CertificateController {
    constructor(private readonly certificates: CertificateService) {}

    @Patch(':specId')
    @HttpCode(200)
    async upload(@Param('specId', ResourceIdPipe) specId: string, @Body(JsonObjectBodyPipe) body: string, @Req() req: Request): Promise<{ id: string }> {
        await this.certificates.upload(req, specId, body);
        return { id: specId };
    }

    @All(['', '{*path}'])
    closed(): never {
        throw new NotFoundError('Not found');
    }
}
