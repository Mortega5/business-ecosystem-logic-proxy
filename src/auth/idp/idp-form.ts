import { z } from 'zod';

/** What names an identity provider in the addresses of the proxy (`/login/<id>`, `/auth/<id>/callback`): nothing that needs escaping. */
export const IDP_ID = /^[A-Za-z0-9._:-]{1,128}$/;

const server = z
    .url()
    .max(2000)
    .refine((value) => /^https?:\/\//i.test(value), 'must be an http or https address');

const fields = {
    name: z.string().trim().min(1).max(200),
    server,
    issuerDid: z.string().trim().min(1).max(500).optional(),
    description: z.string().trim().min(1).max(2000).optional()
};

/** What an administrator sends to add an identity provider, and nothing else. */
export const newIdpForm = z.strictObject({ idpId: z.string().regex(IDP_ID), ...fields });

/** What is sent to change one: all its fields, because what is left out is removed. The id is the one of the address. */
export const idpChangeForm = z.strictObject(fields);

export type NewIdpForm = z.infer<typeof newIdpForm>;
export type IdpChangeForm = z.infer<typeof idpChangeForm>;

/** What is told of an identity provider. */
export interface IdpView {
    name: string;
    server: string;
    idpId: string;
    issuerDid?: string;
    description?: string;
}
