import { Injectable, UseGuards, applyDecorators, type CanActivate } from '@nestjs/common';
import { NotFoundError } from '../common/domain-error';
import { AppConfigService } from '../config/app-config.service';

/** The routes of the extension exist only while `dome.enabled` is on. */
@Injectable()
export class DomeEnabledGuard implements CanActivate {
    constructor(private readonly config: AppConfigService) {}

    canActivate(): boolean {
        if (this.config.dome.enabled) {
            return true;
        }
        // NotFoundError and not NotFoundException: the latter is handed to the legacy application, which would serve the route
        throw new NotFoundError('Not found');
    }
}

/** Marks a controller of the DOME extension: with the extension off, all its routes answer 404. */
export const DomeRoutes = (): ClassDecorator & MethodDecorator => applyDecorators(UseGuards(DomeEnabledGuard));
