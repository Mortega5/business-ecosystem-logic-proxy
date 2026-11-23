import { Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { AppConfigService } from '../../../config/app-config.service';
import { CatalogDefaults } from '../catalog-defaults';
import { UpstreamPlatformApi } from './upstream-platform-api';
import { PlatformBootstrap } from './platform-bootstrap';
import { PlatformRecords } from './platform-records';

/**
 * Makes sure, every time the proxy starts and in the background, of what the platform keeps in the TMForum (see `PlatformBootstrap`): the
 * server answers meanwhile, and each step tries again until it is done, since the APIs it needs may not be up yet. `catalog.bootstrap.enabled`
 * turns it off, and then it does nothing at all.
 */
@Injectable()
export class CatalogBootstrapService implements OnApplicationBootstrap, OnApplicationShutdown {
    private stopped = false;
    private cancelWait: (() => void) | undefined;

    constructor(
        private readonly config: AppConfigService,
        private readonly defaults: CatalogDefaults,
        private readonly records: PlatformRecords,
        private readonly api: UpstreamPlatformApi,
        private readonly logger: PinoLogger
    ) {
        this.logger.setContext(CatalogBootstrapService.name);
    }

    onApplicationBootstrap(): void {
        const { enabled } = this.config.catalog.bootstrap;
        if (!enabled) {
            this.logger.info('The start-up of the default catalog and the system categories is off (catalog.bootstrap.enabled)');
            return;
        }
        const { catalog, auth } = this.config;
        const bootstrap = new PlatformBootstrap(
            {
                defaultCatalogId: catalog.defaultCatalogId,
                defaultCatalogName: catalog.defaultCatalogName,
                systemCategories: catalog.systemCategories,
                sellerRole: auth.roles.seller,
                records: catalog.bootstrap.records
            },
            this.records,
            this.api,
            this.api,
            { info: (message) => this.logger.info(message), warn: (message) => this.logger.warn(message) }
        );
        void this.untilDone('Default catalog and system categories', async () => {
            const { defaultCatalogId, systemCategoryIds } = await bootstrap.ensure();
            this.defaults.set(defaultCatalogId, systemCategoryIds);
        });
        // Apart from the catalog: the software API is a service of its own, and the catalog must not wait for it
        void this.untilDone('Software support package spec', async () => {
            this.defaults.setSupportPackageSpecId(await bootstrap.ensureSupportPackageSpec());
        });
    }

    onApplicationShutdown(): void {
        this.stopped = true;
        this.cancelWait?.();
    }

    private async untilDone(name: string, step: () => Promise<void>): Promise<void> {
        const { retryDelayMs } = this.config.catalog.bootstrap;
        for (let attempt = 1; !this.stopped; attempt += 1) {
            try {
                await step();
                this.logger.info({ attempt }, `${name}: done`);
                return;
            } catch (error) {
                this.logger.warn({ attempt, delayMs: retryDelayMs, err: error }, `${name}: it could not be done, retrying`);
                await this.wait(retryDelayMs);
            }
        }
    }

    private wait(ms: number): Promise<void> {
        return new Promise((resolve) => {
            const timer = setTimeout(resolve, ms);
            this.cancelWait = () => {
                clearTimeout(timer);
                resolve();
            };
        });
    }
}
