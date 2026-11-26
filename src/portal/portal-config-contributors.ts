import { Injectable, Logger } from '@nestjs/common';

type Json = Record<string, unknown>;

/** What a module that is not part of the core adds to the settings the portal reads when it starts. */
export type PortalConfigContributor = () => Promise<Json> | Json;

/**
 * The settings that extensions add to `GET /config`. A contributor that fails is left out and the portal still starts; a key that the
 * core gives is never replaced by one of an extension.
 */
@Injectable()
export class PortalConfigContributors {
    private readonly logger = new Logger(PortalConfigContributors.name);
    private readonly contributors: { name: string; contribute: PortalConfigContributor }[] = [];

    register(name: string, contribute: PortalConfigContributor): void {
        this.contributors.push({ name, contribute });
    }

    async collect(): Promise<Json> {
        const parts = await Promise.all(
            this.contributors.map(async ({ name, contribute }) => {
                try {
                    return await contribute();
                } catch (error) {
                    this.logger.warn({ contributor: name, err: error }, 'The settings of a contributor could not be added to the portal');
                    return {};
                }
            })
        );
        return Object.assign({}, ...parts) as Json;
    }
}
