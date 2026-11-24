import { Injectable } from '@nestjs/common';
import { BadGatewayError } from '../common/domain-error';
import { AppConfigService } from '../config/app-config.service';
import { isRecord } from '../tmf/related-party';
import { isResourceId } from '../tmf/resource-id.pipe';
import type { Figures } from './stats.store';
import { TmfReader } from './tmf-reader';

const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);

/**
 * Reads the figures of the landing page from the TMForum: the names of the launched offerings, and the names of the organisations that sell
 * them. The sellers are the ones the offerings name, so that no specification has to be read one by one.
 */
@Injectable()
export class StatsReader {
    constructor(
        private readonly reader: TmfReader,
        private readonly config: AppConfigService
    ) {}

    async read(signal: AbortSignal): Promise<Figures> {
        const offerings = await this.reader.all('tmforum.catalog', '/productOffering', { lifecycleStatus: 'Launched', fields: 'name,relatedParty' }, signal);
        const services = offerings.flatMap((offering) => text(offering['name']) ?? []);
        const sellers = this.sellers(offerings);
        return { services, organizations: await this.organizations(sellers, signal) };
    }

    private sellers(offerings: Record<string, unknown>[]): string[] {
        const seller = this.config.auth.roles.seller.toLowerCase();
        const ids = new Set<string>();
        for (const offering of offerings) {
            const parties = Array.isArray(offering['relatedParty']) ? (offering['relatedParty'] as unknown[]) : [];
            for (const party of parties) {
                const id = isRecord(party) ? text(party['id']) : undefined;
                if (isRecord(party) && id !== undefined && isResourceId(id) && text(party['role'])?.toLowerCase() === seller) {
                    ids.add(id);
                }
            }
        }
        return [...ids];
    }

    private async organizations(ids: string[], signal: AbortSignal): Promise<string[]> {
        const names: string[] = [];
        const { providersPerQuery } = this.config.limits;
        for (let from = 0; from < ids.length; from += providersPerQuery) {
            signal.throwIfAborted();
            const batch = ids.slice(from, from + providersPerQuery);
            const search = `?id=${batch.map(encodeURIComponent).join(',')}&fields=tradingName&limit=${batch.length}`;
            const found = await this.reader.some('tmforum.party', '/organization', search);
            for (const organization of found) {
                const name = isRecord(organization) ? text(organization['tradingName']) : undefined;
                if (name !== undefined) {
                    names.push(name);
                }
            }
            if (found.length > batch.length) {
                throw new BadGatewayError('/organization answered more organisations than were asked for');
            }
        }
        return names;
    }
}
