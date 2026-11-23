import { All, Body, Controller, Get, Post, Req, Res, UseGuards, UseInterceptors } from '@nestjs/common';
import type { Request, Response } from 'express';
import { BodyTextInterceptor } from '../body-text.interceptor';
import { OptionalAuth } from '../../auth/public.decorator';
import { NotFoundError } from '../../common/domain-error';
import { AdministratorGuard } from '../administrator.guard';
import { AS_JSON, PRIVATE } from '../http-options';
import { JsonObjectBodyPipe } from '../json-body.pipe';
import { TmfProxy } from '../tmf-proxy';
import { checkedFileUpload } from './file-upload';

// The charging backend serves its routes under its own `/charging` prefix, which the proxy leaves in the path
const ORDERS = '/charging/api/orderManagement';


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
        return this.proxy.forward(req, res, { upstream: 'charging', path: `${ORDERS}/orders/confirm/`, body, ...AS_JSON });
    }

    @UseGuards(AdministratorGuard)
    @Get('api/orderManagement/notify/config')
    readNotifyConfig(@Req() req: Request, @Res() res: Response): Promise<void> {
        return this.proxy.forward(req, res, { upstream: 'charging', path: `${ORDERS}/notify/config`, search: '', responseHeaders: PRIVATE });
    }

    @UseGuards(AdministratorGuard)
    @Post('api/orderManagement/notify/config')
    writeNotifyConfig(@Body(JsonObjectBodyPipe) body: string, @Req() req: Request, @Res() res: Response): Promise<void> {
        return this.proxy.forward(req, res, { upstream: 'charging', path: `${ORDERS}/notify/config`, body, ...AS_JSON, responseHeaders: PRIVATE });
    }

    // The file travels in the body in base64, so this is the biggest body the proxy takes
    @Post('api/assetManagement/assets/uploadJob')
    uploadFile(@Body(JsonObjectBodyPipe) body: string, @Req() req: Request, @Res() res: Response): Promise<void> {
        return this.proxy.forward(req, res, { upstream: 'charging', path: '/charging/api/assetManagement/assets/uploadJob', body: checkedFileUpload(body), ...AS_JSON });
    }

    @All(['', '{*path}'])
    closed(): never {
        throw new NotFoundError('Not found');
    }
}
