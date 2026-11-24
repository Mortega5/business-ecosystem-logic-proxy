import { Body, Controller, Get, Patch, UseGuards, UseInterceptors } from '@nestjs/common';
import { BodyTextInterceptor } from '../tmf/body-text.interceptor';
import { AdministratorGuard } from '../tmf/administrator.guard';
import { JsonObjectBodyPipe } from '../tmf/json-body.pipe';
import { AdminConfigService, type SearchConfig } from './admin-config.service';
import type { SearchFilters } from './search-filters';

/**
 * What the administrator changes of the portal, as far as its pages use it: the features, the filters of the search and the setting of the
 * search engine. The settings of the analytics are not here yet and are not closed, so that the legacy application answers them.
 */
@UseInterceptors(BodyTextInterceptor)
@UseGuards(AdministratorGuard)
@Controller('config')
export class AdminConfigController {
    constructor(private readonly admin: AdminConfigService) {}

    @Patch('features')
    features(@Body(JsonObjectBodyPipe) body: string): Promise<Record<string, boolean>> {
        return this.admin.updateFeatures(body);
    }

    @Patch('filters')
    filters(@Body(JsonObjectBodyPipe) body: string): Promise<SearchFilters> {
        return this.admin.updateSearchFilters(body);
    }

    @Get('search')
    search(): Promise<SearchConfig> {
        return this.admin.searchConfig();
    }

    @Patch('search')
    updateSearch(@Body(JsonObjectBodyPipe) body: string): Promise<SearchConfig> {
        return this.admin.updateSearchConfig(body);
    }
}
