import { All, Controller, Get, Param, UseGuards } from '@nestjs/common';
import { Public } from '../auth/public.decorator';
import { NotFoundError } from '../common/domain-error';
import { OwnPartyGuard } from '../tmf/own-party.guard';
import { ResourceIdPipe } from '../tmf/resource-id.pipe';
import { ProviderStats, type LifecycleCounts } from './provider-stats';
import { StatsService } from './stats.service';
import type { Figures } from './stats.store';

/**
 * The figures of the landing page, which anybody may read, and the counts of an organisation, which only the organisation and an
 * administrator may. Everything else under /stats is closed here.
 */
@Controller('stats')
export class StatsController {
    constructor(
        private readonly stats: StatsService,
        private readonly providers: ProviderStats
    ) {}

    @Public()
    @Get()
    landing(): Promise<Figures> {
        return this.stats.current();
    }

    @Get('provider/:organizationId')
    @UseGuards(OwnPartyGuard)
    provider(@Param('organizationId', ResourceIdPipe) organizationId: string): Promise<Record<string, LifecycleCounts>> {
        return this.providers.of(organizationId);
    }

    @All(['', '{*path}'])
    closed(): never {
        throw new NotFoundError('Not found');
    }
}
