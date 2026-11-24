import { Inject, Injectable } from '@nestjs/common';
import type { AppConfig } from './config.schema';
import type { UpstreamName } from './upstream-names';
import { resolveUpstream, type ResolvedUpstream } from './upstream-resolution';

export const APP_CONFIG = Symbol('APP_CONFIG');

@Injectable()
export class AppConfigService {
    constructor(@Inject(APP_CONFIG) private readonly value: AppConfig) {}

    get app(): AppConfig['app'] {
        return this.value.app;
    }

    get http(): AppConfig['http'] {
        return this.value.http;
    }

    get logging(): AppConfig['logging'] {
        return this.value.logging;
    }

    get mongo(): AppConfig['mongo'] {
        return this.value.mongo;
    }

    get security(): AppConfig['security'] {
        return this.value.security;
    }

    get auth(): AppConfig['auth'] {
        return this.value.auth;
    }

    get purchase(): AppConfig['purchase'] {
        return this.value.purchase;
    }

    get quotes(): AppConfig['quotes'] {
        return this.value.quotes;
    }

    get tendering(): AppConfig['tendering'] {
        return this.value.tendering;
    }

    get party(): AppConfig['party'] {
        return this.value.party;
    }

    get dsp(): AppConfig['dsp'] {
        return this.value.dsp;
    }

    get launchValidation(): AppConfig['launchValidation'] {
        return this.value.launchValidation;
    }

    get search(): AppConfig['search'] {
        return this.value.search;
    }

    get dataSpace(): AppConfig['dataSpace'] {
        return this.value.dataSpace;
    }

    get catalogManagement(): AppConfig['catalogManagement'] {
        return this.value.catalogManagement;
    }

    get catalog(): AppConfig['catalog'] {
        return this.value.catalog;
    }

    get limits(): AppConfig['limits'] {
        return this.value.limits;
    }

    get stats(): AppConfig['stats'] {
        return this.value.stats;
    }

    get health(): AppConfig['health'] {
        return this.value.health;
    }

    /** Whether the upstream has a host, so that it can be called. */
    hasUpstream(name: UpstreamName): boolean {
        try {
            resolveUpstream(this.value.upstreams, name);
            return true;
        } catch {
            return false;
        }
    }

    /** The URL and timeout of an upstream; throws when its host is not configured. */
    upstream(name: UpstreamName): ResolvedUpstream {
        return resolveUpstream(this.value.upstreams, name);
    }
}
