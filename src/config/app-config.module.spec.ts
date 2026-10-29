import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { AppConfigModule } from './app-config.module';
import { AppConfigService } from './app-config.service';

describe('AppConfigModule', () => {
    it('loads the shipped defaults when nothing overrides them', async () => {
        const module = await Test.createTestingModule({ imports: [AppConfigModule] }).compile();

        expect(module.get(AppConfigService).app.port).toBe(8004);
    });
});
