import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { AppModule } from './app.module';
import { MongoConnectionService } from './persistence/mongo-connection.service';

describe('AppModule', () => {
    // Compiled exactly as main.ts builds it, so provider wiring that depends on import order shows up here.
    it('resolves its providers', async () => {
        const module = await Test.createTestingModule({ imports: [AppModule] }).compile();

        expect(module.get(MongoConnectionService)).toBeInstanceOf(MongoConnectionService);

        await module.close();
    });
});
