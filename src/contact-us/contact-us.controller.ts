import { Body, Controller, HttpCode, Logger, Post, UseInterceptors } from '@nestjs/common';
import { Public } from '../auth/public.decorator';
import { BadGatewayError } from '../common/domain-error';
import { AppConfigService } from '../config/app-config.service';
import { UpstreamClient, UpstreamError } from '../http-client/upstream-client';
import { BodyTextInterceptor } from '../tmf/body-text.interceptor';
import { JsonObjectBodyPipe } from '../tmf/json-body.pipe';
import { parseRequest } from '../tmf/schemas/parse';
import { contactForm, notificationOf } from './contact-form';

// Where the notification goes when the marketplace does not name another place
const CHARGING_NOTIFICATION = '/charging/api/orderManagement/notify/configured';

/**
 * The contact form of the portal. Anybody may send it, so what is read of it is what the portal asks for and nothing else, and what
 * the notification says of it is escaped. The notification goes to the address of the marketplace for it, or to the charging backend.
 */
@Public()
@UseInterceptors(BodyTextInterceptor)
@Controller('contact-us')
export class ContactUsController {
    private readonly logger = new Logger(ContactUsController.name);

    constructor(
        private readonly upstream: UpstreamClient,
        private readonly config: AppConfigService
    ) {}

    @Post()
    @HttpCode(200)
    async send(@Body(JsonObjectBodyPipe) body: string): Promise<{ sent: true }> {
        const form = parseRequest(contactForm(this.config.limits), JSON.parse(body), 'Invalid contact form');
        const own = this.config.hasUpstream('contactUs');
        let status: number;
        try {
            const response = await this.upstream.send({
                upstream: own ? 'contactUs' : 'charging',
                path: own ? '' : CHARGING_NOTIFICATION,
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(notificationOf(form))
            });
            status = response.status;
        } catch (error) {
            this.logger.warn(`The contact form could not be notified: ${error instanceof UpstreamError ? error.message : 'unknown error'}`);
            throw new BadGatewayError('The message could not be sent');
        }
        if (status < 200 || status >= 300) {
            this.logger.warn(`The contact form was refused with ${status}`);
            throw new BadGatewayError('The message could not be sent');
        }
        return { sent: true };
    }
}
