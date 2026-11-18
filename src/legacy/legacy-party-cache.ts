import { Injectable } from '@nestjs/common';

interface LegacyPartyClient {
    clearPartyCache: (partyId: string) => void;
}

/**
 * The legacy application keeps the parties it has read in memory, for two hours, and uses them for the login, the
 * catalog and the compliance checks. A party changed here has to be forgotten there; the module is loaded when it is first
 * needed, and it is the one the legacy application uses because both live in this process.
 */
@Injectable()
export class LegacyPartyCache {
    clear(partyId: string): void {
        const { partyClient } = require('../../lib/party') as { partyClient: LegacyPartyClient };
        partyClient.clearPartyCache(partyId);
    }
}
