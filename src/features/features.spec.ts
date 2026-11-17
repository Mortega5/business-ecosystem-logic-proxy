import { Controller, Get, Module } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import express from 'express';
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

const staticFlags = {
    purchaseEnabled: true,
    dataSpaceEnabled: false,
    catalogManagementEnabled: true,
    dspEnabled: false,
    quotesEnabled: true,
    tenderingEnabled: true,
    launchValidationEnabled: false,
    tenderDevButtonsOpenCloseEnabled: false
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

const build = (documents: FakeDocuments) => new FeatureFlagService({ features: staticFlags } as AppConfigService, documents);

describe('FeatureFlagService', () => {
    let documents: FakeDocuments;
    beforeEach(() => {
        documents = new FakeDocuments();
    });

    it('uses the static flags when the DB has no document', async () => {
        const service = build(documents);
        expect(await service.isEnabled('purchaseEnabled')).toBe(true);
        expect(await service.isEnabled('dspEnabled')).toBe(false);
    });

    it('lets the boolean overrides of the DB win and ignores anything else', async () => {
        documents.document = {
            id: 'feature-flags',
            features: { purchaseEnabled: false, dspEnabled: 'yes', quotesEnabled: 1, unknownFlag: true }
        };
        expect(await build(documents).all()).toEqual({ ...staticFlags, purchaseEnabled: false });
    });

    it('falls back to the static flags when the DB fails', async () => {
        documents.failing = true;
        expect(await build(documents).isEnabled('quotesEnabled')).toBe(true);
    });

    it('reads the DB once per refresh period', async () => {
        vi.useFakeTimers();
        try {
            const service = build(documents);
            await service.isEnabled('purchaseEnabled');
            await service.isEnabled('dspEnabled');
            expect(documents.reads).toBe(1);
            vi.advanceTimersByTime(6000);
            await service.isEnabled('dspEnabled');
            expect(documents.reads).toBe(2);
        } finally {
            vi.useRealTimers();
        }
    });
});

@Controller('gated')
class GatedController {
    @Get('on')
    @RequireFeature('purchaseEnabled')
    on() {
        return { ok: true };
    }

    @Get('off')
    @RequireFeature('dspEnabled')
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
                { provide: AppConfigService, useValue: { features: staticFlags } },
                FeatureFlagService,
                { provide: APP_GUARD, useClass: FeatureGuard }
            ]
        })
        class Root {}
        const legacy = express();
        legacy.get('/legacy', (_req, res) => {
            res.json({ from: 'legacy' });
        });
        app = await createApp(legacy, Root);
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

    it('answers 404 without handing the request to the legacy app when the flag is off', async () => {
        const res = await fetch(`${url}/gated/off`);
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: 'Not found' });
    });

    it('leaves routes without the decorator alone', async () => {
        expect((await fetch(`${url}/gated/free`)).status).toBe(200);
    });
});
