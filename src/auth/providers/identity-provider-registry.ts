import { Injectable } from '@nestjs/common';
import type { IdentityProvider } from './identity-provider';

export const LOCAL_IDP = 'local';

/** The identity providers that are in use: the main one as `local`, and the external ones that are added and removed at run time. */
@Injectable()
export class IdentityProviderRegistry {
    private readonly providers = new Map<string, IdentityProvider>();

    add(provider: IdentityProvider): void {
        this.providers.set(provider.id, provider);
    }

    remove(id: string): void {
        this.providers.delete(id);
    }

    get(id: string): IdentityProvider | undefined {
        return this.providers.get(id);
    }
}
