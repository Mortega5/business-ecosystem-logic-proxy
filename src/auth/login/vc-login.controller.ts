import { Controller, Get, Header, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { UnauthorizedError } from '../../common/domain-error';
import { Public } from '../public.decorator';
import { VcEnabledGuard } from './vc-enabled.guard';
import { VcLoginService } from './vc-login.service';

/** Where the user is sent when a login does not complete. */
const FAILURE_PATH = '/error';

/**
 * The login with credentials: what the wallet and the verifier call, and what the portal polls. They are open because who calls them has
 * no session yet; what they give is the session of the browser that waits for the answer, and nothing else.
 */
@UseGuards(VcEnabledGuard)
@Controller()
export class VcLoginController {
    constructor(private readonly login: VcLoginService) {}

    /** What the wallet asks for to know what the proxy wants of the user, when the user comes back to the proxy. */
    @Public()
    @Get('auth/vc/request.jwt')
    @Header('content-type', 'text/plain; charset=utf-8')
    request(): string {
        return this.login.requestObject();
    }

    /** The user comes back to the proxy with the code, or the verifier tells the proxy the code of the user who is elsewhere. */
    @Public()
    @Get('auth/vc/callback')
    async callback(@Query('state') state: unknown, @Query('code') code: unknown, @Req() req: Request, @Res() res: Response): Promise<void> {
        if (this.login.redirects) {
            try {
                const profile = await this.login.finishRedirection(state, code);
                req.session.accessToken = profile.accessToken;
            } catch (error) {
                if (error instanceof UnauthorizedError) {
                    res.redirect(FAILURE_PATH);
                    return;
                }
                throw error;
            }
            await this.newSession(req);
            res.redirect('/dashboard?token=local');
            return;
        }
        await this.login.receive(state, code);
        res.status(200).end();
    }

    /** The portal asks whether the user has shown the credential: a 401 while it has not, and the session of the browser when it has. */
    @Public()
    @Get('poll')
    async poll(@Query('state') state: unknown, @Req() req: Request, @Res() res: Response): Promise<void> {
        // Something in the session, so that the cookie reaches the browser and its next question is known to be the same browser's
        req.session.vcPolling = true;
        const profile = await this.login.poll(state, req.sessionID);
        req.session.accessToken = profile.accessToken;
        await this.newSession(req);
        res.status(200).json({});
    }

    /** The portal asks for the credential of a certification that the user showed. */
    @Public()
    @Get('cert/poll')
    certificate(@Query('state') state: unknown): Promise<{ vc: string; subject: Record<string, unknown> }> {
        return this.login.pollCertificate(state);
    }

    // A new session for the user who has logged in, so that nobody who knew the previous one gets in with it
    private async newSession(req: Request): Promise<void> {
        const { accessToken } = req.session;
        await new Promise<void>((resolve, reject) => req.session.regenerate((error: unknown) => (error ? reject(error as Error) : resolve())));
        if (accessToken !== undefined) {
            req.session.accessToken = accessToken;
        }
    }
}
