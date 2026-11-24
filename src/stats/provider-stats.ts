import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import type { UpstreamName } from '../config/upstream-names';
import { TmfReader } from './tmf-reader';

const LIFECYCLE_STATUSES = ['Active', 'Launched', 'Retired', 'Obsolete'] as const;

export type LifecycleCounts = Record<(typeof LIFECYCLE_STATUSES)[number], number>;

const RESOURCES: { key: string; upstream: UpstreamName; path: string }[] = [
    { key: 'productOffering', upstream: 'tmforum.catalog', path: '/productOffering' },
    { key: 'catalog', upstream: 'tmforum.catalog', path: '/catalog' },
    { key: 'productSpecification', upstream: 'tmforum.catalog', path: '/productSpecification' },
    { key: 'serviceSpecification', upstream: 'tmforum.service', path: '/serviceSpecification' },
    { key: 'resourceSpecification', upstream: 'tmforum.resource', path: '/resourceSpecification' },
    { key: 'usageSpecification', upstream: 'tmforum.usage', path: '/usageSpecification' }
];

// What is kept for an organisation is a few numbers, but who may ask is not unlimited: an administrator may ask for any id
const MAX_KEPT = 500;

interface Kept {
    at: number;
    counts: Record<string, LifecycleCounts>;
}

/**
 * How many things of each lifecycle status an organisation has in the six collections that a provider keeps. The counts are kept in memory
 * for `stats.providerTtlMs`, and what asks for the same organisation while they are being read waits for the same reading.
 */
@Injectable()
export class ProviderStats {
    private readonly kept = new Map<string, Kept>();
    private readonly reading = new Map<string, Promise<Kept>>();

    constructor(
        private readonly reader: TmfReader,
        private readonly config: AppConfigService
    ) {}

    async of(organizationId: string): Promise<Record<string, LifecycleCounts>> {
        const now = Date.now();
        const kept = this.kept.get(organizationId);
        if (kept !== undefined && now - kept.at < this.config.stats.providerTtlMs) {
            return kept.counts;
        }
        let reading = this.reading.get(organizationId);
        if (reading === undefined) {
            reading = this.read(organizationId)
                .then((read) => {
                    this.keep(organizationId, read);
                    return read;
                })
                .finally(() => this.reading.delete(organizationId));
            this.reading.set(organizationId, reading);
        }
        return (await reading).counts;
    }

    private keep(organizationId: string, read: Kept): void {
        const now = Date.now();
        if (this.kept.size >= MAX_KEPT) {
            for (const [id, entry] of this.kept) {
                if (now - entry.at >= this.config.stats.providerTtlMs) {
                    this.kept.delete(id);
                }
            }
        }
        if (this.kept.size >= MAX_KEPT) {
            const oldest = this.kept.keys().next();
            if (oldest.done !== true) {
                this.kept.delete(oldest.value);
            }
        }
        this.kept.set(organizationId, read);
    }

    private async read(organizationId: string): Promise<Kept> {
        const counted = await Promise.all(
            RESOURCES.map(async ({ key, upstream, path }) => {
                const items = await this.reader.all(upstream, path, { 'relatedParty.id': organizationId, fields: 'lifecycleStatus' });
                return [key, count(items)] as const;
            })
        );
        return { at: Date.now(), counts: Object.fromEntries(counted) };
    }
}

const count = (items: Record<string, unknown>[]): LifecycleCounts => {
    const counts: LifecycleCounts = { Active: 0, Launched: 0, Retired: 0, Obsolete: 0 };
    for (const item of items) {
        const status = typeof item['lifecycleStatus'] === 'string' ? item['lifecycleStatus'].toLowerCase() : '';
        const found = LIFECYCLE_STATUSES.find((valid) => valid.toLowerCase() === status);
        if (found !== undefined) {
            counts[found] += 1;
        }
    }
    return counts;
};
