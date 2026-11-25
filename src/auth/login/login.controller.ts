import { All, Controller, Get, Param, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { UnauthorizedError } from '../../common/domain-error';
import { AppConfigService } from '../../config/app-config.service';
import { Public } from '../public.decorator';
import type { UserProfile } from '../profile/user-profile';
import { LOCAL_IDP } from '../providers/identity-provider-registry';
import { LoginService, sitePath } from './login.service';

/** Where the user is sent when a login does not complete. */
const FAILURE_PATH = '/error';

/** The path of this site the user came from: the one the portal says, or else the page that linked here. */
const cameFrom = (req: Request): string => {
    const asked = req.query['came_from'];
    if (typeof asked === 'string') {
        return sitePath(asked);
    }
    const referer = req.headers['referer'];
    if (typeof referer === 'string') {
        try {
            const url = new URL(referer);
            return url.host === req.headers['host'] ? sitePath(`${url.pathname}${url.search}`) : '/';
        } catch {
            return '/';
        }
    }
    return '/';
};

/** The login with an identity provider, the logout and the token of who is logged in. */
@Controller()
export class LoginController {
    constructor(
        private readonly login: LoginService,
        private readonly config: AppConfigService
    ) {}

    @Public()
    @All('login')
    start(@Req() req: Request, @Res() res: Response): Promise<void> {
        return this.redirectToProvider(req, res, LOCAL_IDP);
    }

    @Public()
    @All('login/:idp')
    startWith(@Param('idp') idp: string, @Req() req: Request, @Res() res: Response): Promise<void> {
        return this.redirectToProvider(req, res, idp);
    }

    /** The main provider is called by its name in the address, as in v11 (`/auth/keycloak/callback`); the others by their id. */
    @Public()
    @Get('auth/:idp/callback')
    async callback(@Param('idp') idp: string, @Query() query: Record<string, unknown>, @Req() req: Request, @Res() res: Response): Promise<void> {
        const id = idp === this.config.auth.idp.provider ? LOCAL_IDP : idp;
        let redirectTo: string;
        try {
            ({ redirectTo } = await this.login.complete(req.session, id, query));
        } catch (error) {
            if (error instanceof UnauthorizedError) {
                res.redirect(FAILURE_PATH);
                return;
            }
            throw error;
        }
        // A new session for the user who has logged in, so that nobody who knew the previous one gets in with it
        const { accessToken } = req.session;
        await new Promise<void>((resolve, reject) => req.session.regenerate((error: unknown) => (error ? reject(error as Error) : resolve())));
        req.session.accessToken = accessToken as string;
        res.redirect(redirectTo);
    }

    @Public()
    @All('logOut')
    async logout(@Req() req: Request, @Res() res: Response): Promise<void> {
        await new Promise<void>((resolve, reject) => req.session.destroy((error: unknown) => (error ? reject(error as Error) : resolve())));
        res.redirect('/');
    }

    /** The profile of who is logged in, token included, for a portal that has to call the API with it. */
    @Get('logintoken')
    token(@Req() req: Request, @Res({ passthrough: true }) res: Response): UserProfile {
        const origin = req.headers['origin'];
        // The portal of another site that the configuration lets in may send the cookie of the session
        if (typeof origin === 'string' && this.config.http.cors.origins.includes(origin)) {
            res.header('Access-Control-Allow-Credentials', 'true');
        }
        return (req as Request & { user: UserProfile }).user;
    }

    private async redirectToProvider(req: Request, res: Response, idp: string): Promise<void> {
        res.redirect(await this.login.begin(req.session, idp, cameFrom(req)));
    }
}
