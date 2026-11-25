import { Injectable } from '@nestjs/common';
import type { IdentityProvider } from './identity-provider';

export const LOCAL_IDP = 'local';

/** The identity providers that are in use: the main one as `local`, and the external ones that are added and removed at run time. */
@Injectable()
export class IdentityProviderRegistry {
    private readonly providers = new Map<string, IdentityProvider>();
    private readonly callbacks = new Map<string, string>();

    /** `callbackUrl` is where the provider sends the user back after the login, the redirect URI registered with it. */
    add(provider: IdentityProvider, callbackUrl?: string): void {
        this.providers.set(provider.id, provider);
        if (callbackUrl === undefined) {
            this.callbacks.delete(provider.id);
        } else {
            this.callbacks.set(provider.id, callbackUrl);
        }
    }

    remove(id: string): void {
        this.providers.delete(id);
        this.callbacks.delete(id);
    }

    callbackUrlOf(id: string): string | undefined {
        return this.callbacks.get(id);
    }

    get(id: string): IdentityProvider | undefined {
        return this.providers.get(id);
    }
}
