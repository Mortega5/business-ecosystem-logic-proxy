import { Controller, Get, Module } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../bootstrap';
import { AppConfigModule } from '../config/app-config.module';
import { AppConfigService } from '../config/app-config.service';
import { LoggingModule } from '../logging/logging.module';
import { ConfigDocumentRepository, type ConfigDocument } from '../persistence/config-store/config-document.repository';
import { FeatureFlagService } from './feature-flag.service';
import { FeatureGuard } from './feature.guard';
import { RequireFeature } from './require-feature';
import { APP_GUARD } from '@nestjs/core';

const staticValues = {
    purchase: { enabled: true },
    dataSpace: { enabled: false },
    catalogManagement: { enabled: true },
    dsp: { enabled: false, contractDefinitionSchema: undefined },
    quotes: { enabled: true },
    tendering: { enabled: true, devButtonsOpenClose: false },
    launchValidation: { enabled: false },
    datasets: { enabled: false },
    apiAccess: { enabled: false },
    blueprints: { enabled: true },
    software: { enabled: true },
    blog: { enabled: true },
    compliance: { enabled: true }
};
const staticConfig = staticValues as unknown as AppConfigService;

const staticFeatures = {
    purchase: true,
    dataSpace: false,
    catalogManagement: true,
    dsp: false,
    quotes: true,
    tendering: true,
    launchValidation: false,
    datasets: false,
    apiAccess: false,
    blueprints: true,
    software: true,
    blog: true,
    compliance: true,
    tenderDevButtons: false
};

class FakeDocuments extends ConfigDocumentRepository {
    document: ConfigDocument | undefined;
    failing = false;
    reads = 0;

    findById(): Promise<ConfigDocument | undefined> {
        this.reads += 1;
        return this.failing ? Promise.reject(new Error('mongo down')) : Promise.resolve(this.document);
    }

    upsert(): Promise<void> {
        return Promise.resolve();
    }
}

const build = (documents: FakeDocuments, config: AppConfigService = staticConfig) => new FeatureFlagService(config, documents);

describe('FeatureFlagService', () => {
    let documents: FakeDocuments;
    beforeEach(() => {
        documents = new FakeDocuments();
    });

    it('uses the static flags when the DB has no document', async () => {
        const service = build(documents);
        expect(await service.isEnabled('purchase')).toBe(true);
        expect(await service.isEnabled('dsp')).toBe(false);
    });

    it('lets the boolean overrides of the DB win and ignores anything else', async () => {
        documents.document = {
            id: 'feature-flags',
            features: { purchaseEnabled: false, dspEnabled: 'yes', quotesEnabled: 1, unknownFlag: true }
        };
        expect(await build(documents).all()).toEqual({ ...staticFeatures, purchase: false });
    });

    it('applies the DB override to the tender dev buttons', async () => {
        documents.document = { id: 'feature-flags', features: { tenderDevButtonsOpenCloseEnabled: true } };
        expect(await build(documents).isEnabled('tenderDevButtons')).toBe(true);
    });

    it('keeps a feature off when the DB turns it on but its configuration is incomplete', async () => {
        documents.document = { id: 'feature-flags', features: { dspEnabled: true } };
        expect(await build(documents).isEnabled('dsp')).toBe(false);

        const configured = {
            ...staticValues,
            dsp: { enabled: false, contractDefinitionSchema: 'https://schemas.example.org/dsp.json' }
        } as unknown as AppConfigService;
        expect(await build(documents, configured).isEnabled('dsp')).toBe(true);
    });

    it('falls back to the static flags when the DB fails', async () => {
        documents.failing = true;
        expect(await build(documents).isEnabled('quotes')).toBe(true);
    });

    it('reads the DB once per refresh period', async () => {
        vi.useFakeTimers();
        try {
            const service = build(documents);
            await service.isEnabled('purchase');
            await service.isEnabled('dsp');
            expect(documents.reads).toBe(1);
            vi.advanceTimersByTime(6000);
            await service.isEnabled('dsp');
            expect(documents.reads).toBe(2);
        } finally {
            vi.useRealTimers();
        }
    });
});

@Controller('gated')
class GatedController {
    @Get('on')
    @RequireFeature('purchase')
    on() {
        return { ok: true };
    }

    @Get('off')
    @RequireFeature('dsp')
    off() {
        return { ok: true };
    }

    @Get('free')
    free() {
        return { ok: true };
    }
}

describe('@RequireFeature', () => {
    let app: NestExpressApplication;
    let url: string;

    beforeAll(async () => {
        @Module({
            imports: [AppConfigModule, LoggingModule],
            controllers: [GatedController],
            providers: [
                { provide: ConfigDocumentRepository, useClass: FakeDocuments },
                { provide: AppConfigService, useValue: staticConfig },
                FeatureFlagService,
                { provide: APP_GUARD, useClass: FeatureGuard }
            ]
        })
        class Root {}
        app = await createApp(Root);
        await app.listen(0);
        url = await app.getUrl();
    });

    afterAll(async () => {
        await app.close();
    });

    it('serves the route while the flag is on', async () => {
        const res = await fetch(`${url}/gated/on`);
        expect(res.status).toBe(200);
    });

    it('answers 404 when the flag is off', async () => {
        const res = await fetch(`${url}/gated/off`);
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: 'Not found' });
    });

    it('leaves routes without the decorator alone', async () => {
        expect((await fetch(`${url}/gated/free`)).status).toBe(200);
    });
});
