import { All, Body, Controller, HttpCode, Post, Req, UseInterceptors } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { DomainError, NotFoundError } from '../common/domain-error';
import { JsonObjectBodyPipe } from '../tmf/json-body.pipe';
import { BodyTextInterceptor } from '../tmf/body-text.interceptor';
import type { UpstreamUser } from '../tmf/upstream-headers';
import { GuestTokens, TABS } from './guest-token.service';

const guestTokenForm = z.object({ tab: z.string().trim() });

/** The token to embed a dashboard of the analytics: for who is logged in. Anything else under /analytics is closed. */
@UseInterceptors(BodyTextInterceptor)
@Controller('analytics')
export class AnalyticsController {
    constructor(private readonly tokens: GuestTokens) {}

    @Post('guest-token')
    @HttpCode(200)
    async guestToken(@Body(JsonObjectBodyPipe) body: string, @Req() req: Request): Promise<{ dashboardId: string; token: string }> {
        const form = guestTokenForm.safeParse(JSON.parse(body));
        const tab = form.success ? TABS.find((candidate) => candidate === form.data.tab) : undefined;
        if (tab === undefined) {
            throw new DomainError('A valid tab is required', 400);
        }
        // The route is private, so the authentication has put the user there
        return this.tokens.create((req as Request & { user: UpstreamUser }).user, tab);
    }

    @All(['', '{*path}'])
    closed(): never {
        throw new NotFoundError('Not found');
    }
}
