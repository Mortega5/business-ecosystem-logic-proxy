import { IdpError } from './idp-http';
import type { IdentityClaims, ProfileOrganization, ProfileRole } from '../profile/user-profile';

type Json = Record<string, unknown>;

/** The names of the roles of the platform that a credential is translated to, and the identifiers that make a user an administrator. */
export interface CredentialPolicy {
    roles: { admin: string, customer: string, seller: string, orgAdmin: string, certifier: string };
    /** Issuers, or organisation identifiers, whose users are administrators of the platform. */
    operators: string[];
}

const isRecord = (value: unknown): value is Json =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);
const role = (name: string): ProfileRole => ({ id: name, name });

/** The id of the issuer of a credential, which is either a string or an object with an `id` or a `did`. */
const issuerOf = (issuer: unknown): string | undefined => {
    if (typeof issuer === 'string' && issuer !== '') {
        return issuer;
    }
    return isRecord(issuer) ? (text(issuer['id']) ?? text(issuer['did'])) : undefined;
};

const typesOf = (type: unknown): string[] =>
    (Array.isArray(type) ? type : [type]).filter((entry): entry is string => typeof entry === 'string');

type Kind = 'employee' | 'machine' | 'default';

/** The format of the credential: the two of the LEAR issuer of DOME, or else the one of the FIWARE issuer. */
const kindOf = (type: unknown): Kind => {
    let kind: Kind = 'default';
    for (const entry of typesOf(type)) {
        const lower = entry.toLowerCase();
        if (entry === 'LEARCredentialEmployee' || lower.startsWith('learcredential.employee.w3c.')) {
            kind = 'employee';
        } else if (entry === 'LEARCredentialMachine' || lower.startsWith('learcredential.machine.w3c.')) {
            kind = 'machine';
        }
    }
    return kind;
};

const hasPower = (action: unknown, name: string): boolean =>
    (typeof action === 'string' ? [action] : Array.isArray(action) ? action : []).some(
        (entry) => typeof entry === 'string' && entry.toLowerCase() === name.toLowerCase()
    );

/** What a power of a mandate says it is for: its function and its action, in any of the three spellings that the issuers use. */
const powerOf = (power: unknown): { func: string, action: unknown } => {
    if (!isRecord(power)) {
        return { func: '', action: undefined };
    }
    const func = power['function'] ?? power['tmf_function'] ?? power['tmfFunction'];
    const action = power['function'] != null ? power['action'] : (power['tmf_action'] ?? power['tmfAction']);
    return { func: typeof func === 'string' ? func.toLowerCase() : '', action };
};

/**
 * The roles that the powers of a mandate give in the organisation: onboarding makes the user its administrator, creating and updating
 * product offerings a seller, and uploading certifications a certifier. A machine cannot upload by the name `uploadCertificate`.
 */
const rolesOfMandate = (mandate: Json, policy: CredentialPolicy, kind: 'employee' | 'machine'): ProfileRole[] => {
    const powers = Array.isArray(mandate['power']) ? mandate['power'] : [];
    const names = new Set<string>();
    for (const power of powers) {
        const { func, action } = powerOf(power);
        if (func === 'onboarding' && hasPower(action, 'execute')) {
            names.add(policy.roles.orgAdmin);
        } else if (func === 'productoffering' && hasPower(action, 'create') && hasPower(action, 'update')) {
            names.add(policy.roles.seller);
        } else if (
            func === 'certification' &&
            (hasPower(action, 'upload') ||
                hasPower(action, 'post_verifiable_certification') ||
                (kind === 'employee' && hasPower(action, 'uploadCertificate')))
        ) {
            names.add(policy.roles.certifier);
        }
    }
    return [...names].map(role);
};

interface Subject {
    id: string | undefined;
    email: string | undefined;
    familyName: string | undefined;
    firstName: string | undefined;
    roles: ProfileRole[];
    organization: ProfileOrganization;
}

/** The credential of the issuer of FIWARE: the person, with the roles it says, in an organisation that is the issuer. */
const defaultSubject = (subject: Json, issuer: string, policy: CredentialPolicy): Subject => {
    const email = text(subject['email']);
    const groups = Array.isArray(subject['roles']) ? subject['roles'] : [];
    const first = groups[0];
    const names =
        isRecord(first) && Array.isArray(first['names'])
            ? first['names'].filter((name): name is string => typeof name === 'string')
            : [];
    return {
        id: email ?? `${issuer}:individual`,
        email: email ?? `${issuer.replaceAll(':', '.')}@email.com`,
        familyName: text(subject['familyName']),
        firstName: text(subject['firstName']),
        roles: names.map(role),
        organization: {
            id: issuer,
            name: issuer,
            roles: [policy.roles.seller, policy.roles.customer, policy.roles.orgAdmin].map(role)
        }
    };
};

/** The credential of the LEAR issuer: the mandatee acts for the mandator, and the powers of the mandate are their roles in it. */
const learSubject = (
    subject: Json,
    issuer: unknown,
    policy: CredentialPolicy,
    kind: 'employee' | 'machine'
): Subject => {
    const mandate = subject['mandate'];
    if (!isRecord(mandate) || !isRecord(mandate['mandatee']) || !isRecord(mandate['mandator'])) {
        throw new IdpError('The credential has no mandate');
    }
    const mandatee = mandate['mandatee'];
    const mandator = mandate['mandator'];
    const organizationId = text(mandator['organizationIdentifier']);
    if (organizationId === undefined) {
        throw new IdpError('The credential has no organisation');
    }
    const operator = [issuerOf(issuer), organizationId].some(
        (candidate) => candidate !== undefined && policy.operators.includes(candidate)
    );
    const contact = isRecord(mandatee['contact']) ? mandatee['contact'] : {};
    const serviceName = text(mandatee['serviceName']);
    const familyName = text(mandatee['last_name']) ?? text(mandatee['lastName']);
    const country = text(mandator['country']);
    return {
        id: text(mandatee['id']) ?? text(subject['id']),
        email:
            text(mandatee['email']) ??
            (kind === 'machine'
                ? (text(contact['email']) ?? text(mandator['emailAddress']) ?? text(mandator['email']))
                : undefined),
        familyName: familyName ?? (kind === 'machine' ? serviceName : undefined),
        firstName:
            text(mandatee['first_name']) ??
            text(mandatee['firstName']) ??
            (familyName === undefined && kind === 'machine' ? serviceName : undefined),
        roles: operator ? [role(policy.roles.admin)] : [],
        organization: {
            id: organizationId,
            name: text(mandator['organization']) ?? organizationId,
            roles: rolesOfMandate(mandate, policy, kind),
            ...(country === undefined ? {} : { country })
        }
    };
};

/** The credential inside what the verifier signed: the token carries it as it is, or inside a `vc`, a `verifiableCredential` or a presentation. */
const credentialIn = (payload: Json): Json => {
    if ('credentialSubject' in payload) {
        return payload;
    }
    for (const wrapper of ['verifiableCredential', 'vc']) {
        const inner = payload[wrapper];
        if (isRecord(inner)) {
            return inner;
        }
    }
    const presentations = payload['verifiablePresentation'];
    if (Array.isArray(presentations)) {
        const present = presentations.filter(isRecord);
        const lear = present.find((entry) => entry['type'] != null && kindOf(entry['type']) !== 'default');
        const found = lear ?? present[0];
        if (found !== undefined) {
            return found;
        }
    }
    throw new IdpError('The token carries no credential');
};

/**
 * Who the credential in a token that the verifier signed says the user is. What the credential says is the verifier's: the signature of
 * the token has been checked before this is called.
 */
export const claimsFromCredential = (payload: Json, policy: CredentialPolicy): IdentityClaims => {
    const credential = credentialIn(payload);
    const subject = credential['credentialSubject'];
    if (!isRecord(subject)) {
        throw new IdpError('The credential has no subject');
    }
    const issuer = issuerOf(credential['issuer']);
    const kind = kindOf(credential['type']);
    const parsed =
        kind === 'default'
            ? defaultSubject(subject, issuer ?? 'unknown', policy)
            : learSubject(subject, credential['issuer'], policy, kind);

    const id = parsed.id ?? text(payload['sub']);
    if (id === undefined || parsed.email === undefined) {
        throw new IdpError('The credential has no user');
    }
    const displayName = [parsed.firstName, parsed.familyName].filter((part) => part !== undefined).join(' ');
    return {
        id,
        // The name is made from the address, as the portal has always shown it
        username: parsed.email.split('@')[0] ?? parsed.email,
        ...(displayName === '' ? {} : { displayName }),
        email: parsed.email,
        roles: parsed.roles,
        organizations: [parsed.organization],
        ...(typeof payload['exp'] === 'number' ? { expire: payload['exp'] } : {}),
        ...(issuer === undefined ? {} : { issuerDid: issuer })
    };
};
