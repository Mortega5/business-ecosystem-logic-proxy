import { All, Body, Controller, HttpCode, Post, Req, Res, UseInterceptors } from '@nestjs/common';
import type { Request, Response } from 'express';
import { NotFoundError } from '../common/domain-error';
import { BodyTextInterceptor } from '../tmf/body-text.interceptor';
import { JsonObjectBodyPipe } from '../tmf/json-body.pipe';
import { RequireFeature } from '../features/require-feature';
import { ComplianceService } from './compliance.service';

/** The compliance certificate of a product, which its seller asks for. Anything else under /compliance is closed. */
@RequireFeature('compliance')
@UseInterceptors(BodyTextInterceptor)
@Controller('compliance')
export class ComplianceController {
    constructor(private readonly compliance: ComplianceService) {}

    @Post('certificate')
    @HttpCode(200)
    async certificate(@Body(JsonObjectBodyPipe) body: string, @Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<unknown> {
        const result = await this.compliance.requestCertificate(req, body);
        res.status(result.status);
        return result.body;
    }

    @All(['', '{*path}'])
    closed(): never {
        throw new NotFoundError('Not found');
    }
}
