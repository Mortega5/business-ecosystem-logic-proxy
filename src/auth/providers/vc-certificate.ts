import { DomainError } from '../../common/domain-error';

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The credential of a certification that a wallet presented, in the token that the verifier signed (whose signature is checked before):
 * it has to come from an issuer that is trusted to certify, it must not have expired, and it has to say what product it certifies and
 * for what. Anything else is a 400 with what is wrong.
 */
export const certificationSubject = (payload: Json, certIssuers: string[], now: () => number = Date.now): Json => {
    const credential = payload['verifiableCredential'];
    if (!isRecord(credential)) {
        throw new DomainError('Invalid VC', 400);
    }
    const issuer = credential['issuer'];
    const did = isRecord(issuer) ? issuer['did'] : undefined;
    if (typeof did !== 'string' || !certIssuers.includes(did)) {
        throw new DomainError('Invalid VC issuer', 400);
    }
    const expires =
        typeof credential['expirationDate'] === 'string' ? Date.parse(credential['expirationDate']) : Number.NaN;
    if (Number.isNaN(expires) || expires < now()) {
        throw new DomainError('The VC is expired', 400);
    }
    const subject = credential['subject'];
    if (!isRecord(subject) || !('product' in subject) || !('compliance' in subject)) {
        throw new DomainError('Invalid VC subject', 400);
    }
    return subject;
};
