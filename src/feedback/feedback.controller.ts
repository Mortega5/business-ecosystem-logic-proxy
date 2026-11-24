import { randomUUID } from 'node:crypto';
import { Body, Controller, HttpCode, Post, UseInterceptors } from '@nestjs/common';
import { Public } from '../auth/public.decorator';
import { AppConfigService } from '../config/app-config.service';
import { BodyTextInterceptor } from '../tmf/body-text.interceptor';
import { JsonObjectBodyPipe } from '../tmf/json-body.pipe';
import { parseRequest } from '../tmf/schemas/parse';
import { feedbackForm } from './feedback-form';
import { FeedbackRepository } from './feedback.repository';
import type { Feedback } from './feedback.schema';

/**
 * The feedback that the portal asks of its visitors. Anybody may send it, so what is kept is what the portal asks for, with the lengths
 * of the limits, and nothing else the visitor sends.
 */
@Public()
@UseInterceptors(BodyTextInterceptor)
@Controller('feedback')
export class FeedbackController {
    constructor(
        private readonly feedback: FeedbackRepository,
        private readonly config: AppConfigService
    ) {}

    @Post()
    @HttpCode(200)
    async send(@Body(JsonObjectBodyPipe) body: string): Promise<Feedback> {
        const form = parseRequest(feedbackForm(this.config.limits), JSON.parse(body), 'Feedback body is not correct');
        return this.feedback.create({
            id: randomUUID(),
            rating: form.rating,
            ...(form.description === undefined ? {} : { description: form.description }),
            ...(form.type === undefined ? {} : { type: form.type }),
            creation_date: new Date().toISOString()
        });
    }
}
