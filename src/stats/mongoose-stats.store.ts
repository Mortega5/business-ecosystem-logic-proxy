import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { StatsEntry } from './stats.schema';
import { StatsStore, type Figures, type StoredFigures } from './stats.store';

const DOCUMENT_ID = 'stats';

const names = (value: unknown): string[] => (Array.isArray(value) ? value.filter((name): name is string => typeof name === 'string') : []);

@Injectable()
export class MongooseStatsStore extends StatsStore {
    constructor(@InjectModel(StatsEntry.name) private readonly model: Model<StatsEntry>) {
        super();
    }

    async latest(): Promise<StoredFigures | undefined> {
        // The newest one: a document of v11 has no date and goes last
        const found = await this.model.findOne().sort({ computedAt: -1 }).lean<Record<string, unknown>>();
        if (found === null) {
            return undefined;
        }
        return {
            services: names(found['services']),
            organizations: names(found['organizations']),
            ...(found['computedAt'] instanceof Date ? { computedAt: found['computedAt'] } : {})
        };
    }

    async save(figures: Figures, computedAt: Date): Promise<void> {
        await this.model.updateOne({ _id: DOCUMENT_ID }, { $set: { services: figures.services, organizations: figures.organizations, computedAt } }, { upsert: true, strict: false });
    }
}
