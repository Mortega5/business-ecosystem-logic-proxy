import { All, Controller, Get, Req } from '@nestjs/common';
import type { Request } from 'express';
import { NotFoundError } from '../common/domain-error';
import type { UpstreamUser } from '../tmf/upstream-headers';
import { PaymentInfoService, type PaymentInfo } from './payment-info.service';

/** How the party of the caller is paid, as far as the portal asks for it; for who is logged in. Anything else under it is closed. */
@Controller('paymentInfo')
export class PaymentController {
    constructor(private readonly payment: PaymentInfoService) {}

    @Get()
    info(@Req() req: Request): Promise<PaymentInfo> {
        // The route is private, so the authentication has put the user there
        return this.payment.of((req as Request & { user: UpstreamUser }).user);
    }

    @All(['', '{*path}'])
    closed(): never {
        throw new NotFoundError('Not found');
    }
}
