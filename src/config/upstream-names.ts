export const TMFORUM_APIS = [
    'catalog',
    'resource',
    'service',
    'ordering',
    'inventory',
    'serviceInventory',
    'resourceInventory',
    'party',
    'account',
    'customer',
    'customerBill',
    'usage',
    'document',
    'invoicing',
    'software',
    'quote'
] as const;

export const STANDALONE_UPSTREAMS = ['charging', 'revenue', 'search', 'contactUs', 'billingEngine'] as const;

export type TmforumApi = (typeof TMFORUM_APIS)[number];
export type UpstreamName = `tmforum.${TmforumApi}` | (typeof STANDALONE_UPSTREAMS)[number];
