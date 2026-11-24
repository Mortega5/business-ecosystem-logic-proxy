import { Controller, Get } from '@nestjs/common';
import { Public } from '../auth/public.decorator';
import { PortalConfigService } from './portal-config.service';

/**
 * The settings that the portal reads when it starts, before anybody has logged in. The routes under /config that are for the
 * administrator are not here yet and are not closed, so that the legacy application answers them.
 */
@Public()
@Controller('config')
export class PortalConfigController {
    constructor(private readonly portal: PortalConfigService) {}

    @Get()
    read(): Promise<Record<string, unknown>> {
        return this.portal.read();
    }
}
