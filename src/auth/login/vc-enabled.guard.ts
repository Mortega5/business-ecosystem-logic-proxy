import { Injectable, type CanActivate } from '@nestjs/common';
import { NotFoundError } from '../../common/domain-error';
import { AppConfigService } from '../../config/app-config.service';

/** The routes of the login with credentials exist only while it is on; otherwise they answer 404, as the other routes that are not there. */
@Injectable()
export class VcEnabledGuard implements CanActivate {
    constructor(private readonly config: AppConfigService) {}

    canActivate(): boolean {
        if (this.config.auth.vc.enabled) {
            return true;
        }
        // NotFoundError and not NotFoundException: the latter would serve the portal to a browser
        throw new NotFoundError('Not found');
    }
}
