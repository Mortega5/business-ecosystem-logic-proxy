import { All, Body, Controller, Get, Post, Req, Res, UseGuards, UseInterceptors } from '@nestjs/common';
import type { Request, Response } from 'express';
import { BodyTextInterceptor } from '../body-text.interceptor';
import { OptionalAuth } from '../../auth/public.decorator';
import { NotFoundError } from '../../common/domain-error';
import { AdministratorGuard } from '../administrator.guard';
import { JsonObjectBodyPipe } from '../json-body.pipe';
import { TmfProxy } from '../tmf-proxy';
import { checkedUploadJob } from './upload-job';

// The charging backend serves its routes under its own `/charging` prefix, which the proxy leaves in the path
const ORDERS = '/charging/api/orderManagement';

// The configuration of the e-mail has the password of the SMTP server, so no cache keeps it
const NOT_CACHED = { 'cache-control': 'private, no-store' };

// What is sent on is JSON that was checked as such, whatever type the client said, so the backend reads it as the proxy did
const JSON_BODY = { contentType: 'application/json' };

/**
 * The charging backend, as far as the portal uses it: the confirmation of an order, which is signed by the payment provider, the
 * configuration of the e-mail of the administrator, and the upload of a file. Everything else under /charging, the refund of an
 * order included, is closed here, so it is not handed to the legacy application.
 */
@UseInterceptors(BodyTextInterceptor)
@Controller('charging')
export class ChargingController {
    constructor(private readonly proxy: TmfProxy) {}

    // The signature of the body is what says the provider made it, so a payment that comes back with no session is let in
    @OptionalAuth()
    @Post('api/orderManagement/orders/confirm')
    confirm(@Body(JsonObjectBodyPipe) body: string, @Req() req: Request, @Res() res: Response): Promise<void> {
        return this.proxy.forward(req, res, { upstream: 'charging', path: `${ORDERS}/orders/confirm/`, body, ...JSON_BODY });
    }

    @UseGuards(AdministratorGuard)
    @Get('api/orderManagement/notify/config')
    readNotifyConfig(@Req() req: Request, @Res() res: Response): Promise<void> {
        return this.proxy.forward(req, res, { upstream: 'charging', path: `${ORDERS}/notify/config`, search: '', responseHeaders: NOT_CACHED });
    }

    @UseGuards(AdministratorGuard)
    @Post('api/orderManagement/notify/config')
    writeNotifyConfig(@Body(JsonObjectBodyPipe) body: string, @Req() req: Request, @Res() res: Response): Promise<void> {
        return this.proxy.forward(req, res, { upstream: 'charging', path: `${ORDERS}/notify/config`, body, ...JSON_BODY, responseHeaders: NOT_CACHED });
    }

    // The file travels in the body in base64, so this is the biggest body the proxy takes
    @Post('api/assetManagement/assets/uploadJob')
    uploadJob(@Body(JsonObjectBodyPipe) body: string, @Req() req: Request, @Res() res: Response): Promise<void> {
        return this.proxy.forward(req, res, { upstream: 'charging', path: '/charging/api/assetManagement/assets/uploadJob', body: checkedUploadJob(body), ...JSON_BODY });
    }

    @All(['', '{*path}'])
    closed(): never {
        throw new NotFoundError('Not found');
    }
}
