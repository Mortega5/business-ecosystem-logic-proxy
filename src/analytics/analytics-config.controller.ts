import { Body, Controller, Get, Logger, Patch, UseGuards, UseInterceptors } from '@nestjs/common';
import { BadGatewayError, DomainError } from '../common/domain-error';
import { JsonObjectBodyPipe } from '../tmf/json-body.pipe';
import { AdministratorGuard } from '../tmf/administrator.guard';
import { BodyTextInterceptor } from '../tmf/body-text.interceptor';
import { parseAnalyticsConfig, type AnalyticsConfig } from './analytics-config';
import { AnalyticsSettings } from './analytics-settings';

/**
 * The settings of the analytics that the administrator edits from the portal. Where Superset is decides where the token of every
 * user who asks for a dashboard is sent, so only an administrator reads or changes it.
 */
@UseGuards(AdministratorGuard)
@UseInterceptors(BodyTextInterceptor)
@Controller('config')
export class AnalyticsConfigController {
    private readonly logger = new Logger(AnalyticsConfigController.name);

    constructor(private readonly settings: AnalyticsSettings) {}

    @Get('analytics')
    read(): Promise<AnalyticsConfig> {
        return this.settings.current();
    }

    @Patch('analytics')
    async update(@Body(JsonObjectBodyPipe) body: string): Promise<AnalyticsConfig> {
        const parsed = parseAnalyticsConfig(JSON.parse(body));
        if ('errors' in parsed) {
            throw new DomainError(`Invalid analytics config payload: ${parsed.errors.join('; ')}`, 400);
        }
        try {
            return await this.settings.save(parsed.value);
        } catch (error) {
            this.logger.error(`The analytics settings could not be saved: ${error instanceof Error ? error.name : 'unknown error'}`);
            throw new BadGatewayError('The analytics settings could not be saved');
        }
    }
}
