import type { Request } from 'express';
import { BadGatewayError } from '../../common/domain-error';
import { isRecord } from '../related-party';
import { parseJson, Specifications, type Undo } from '../specification/specifications';
import type { UpstreamUser } from '../upstream-headers';
import { SUPPORT_SPECIFICATION, SUPPORT_SPECIFICATION_NAME, SUPPORT_SPECIFICATION_TYPE, validateDeploymentDefinition } from './software-rules';

const AVAILABLE = { resourceStatus: 'available', usageState: 'active' };
const SUSPENDED = { resourceStatus: 'suspended', usageState: 'idle' };

const supportPackageOf = (specification: Record<string, unknown>): string | undefined => {
    const reference = specification['softwareSupportPackage'];
    return isRecord(reference) && typeof reference['id'] === 'string' ? reference['id'] : undefined;
};

/**
 * The specifications of the software API. A software specification has a support package, a resource that holds its deployment
 * characteristics and that is made with it, changed with it and suspended with it. The steps that come after one that made something
 * take it back when they fail, and when they cannot the client is told what is left.
 */
export class SoftwareSpecifications extends Specifications {
    private supportSpecification: Promise<string> | undefined;

    protected override validate(specification: Record<string, unknown>): void {
        validateDeploymentDefinition(specification);
    }

    protected override async beforeCreate(req: Request, specification: Record<string, unknown>): Promise<Undo | undefined> {
        if (specification['@type'] !== 'SoftwareSpecification') {
            return undefined;
        }
        const supportSpecificationId = await this.supportSpecificationId(req);
        const [seller] = specification['relatedParty'] as Record<string, unknown>[];
        const [owner] = this.sellers.of(seller as Record<string, unknown>, (req as Request & { user: UpstreamUser }).user);
        const created = await this.call(
            req,
            'POST',
            '/resource',
            {
                name: `Software Support Package for ${String(specification['name'])}`,
                '@type': 'SoftwareSupportPackage',
                '@baseType': 'Resource',
                ...AVAILABLE,
                resourceSpecification: { id: supportSpecificationId },
                resourceCharacteristic: specification['resourceCharacteristic'] ?? [],
                relatedParty: [owner]
            },
            'It was impossible to create the software support package'
        );
        const packageId = created['id'];
        if (typeof packageId !== 'string') {
            throw new BadGatewayError('It was impossible to create the software support package');
        }
        delete specification['resourceCharacteristic'];
        specification['softwareSupportPackage'] = { id: packageId };
        return async () => {
            try {
                await this.call(req, 'DELETE', `/resource/${encodeURIComponent(packageId)}`, undefined, '');
                return undefined;
            } catch {
                return `the support package ${packageId} that was made for it could not be removed`;
            }
        };
    }

    protected override prepareUpdate(
        current: Record<string, unknown>,
        changes: Record<string, unknown>
    ): { changes: Record<string, unknown>; after?: (req: Request) => Promise<void> } {
        const packageId = supportPackageOf(current);
        if (current['@type'] !== 'SoftwareSpecification' || !changes['resourceCharacteristic'] || packageId === undefined) {
            return { changes };
        }
        const { resourceCharacteristic, ...rest } = changes;
        return {
            changes: rest,
            after: async (req) => {
                await this.call(
                    req,
                    'PATCH',
                    `/resource/${encodeURIComponent(packageId)}`,
                    { resourceCharacteristic },
                    'The software specification was updated but its characteristics could not be saved in the support package'
                );
            }
        };
    }

    protected override async beforeRetire(req: Request, current: Record<string, unknown>): Promise<Undo | undefined> {
        const packageId = supportPackageOf(current);
        if (packageId === undefined) {
            return undefined;
        }
        const path = `/resource/${encodeURIComponent(packageId)}`;
        await this.call(req, 'PATCH', path, SUSPENDED, 'It was impossible to retire the linked software support package');
        return async () => {
            try {
                await this.call(req, 'PATCH', path, AVAILABLE, '');
                return undefined;
            } catch {
                return `the support package ${packageId} could not be made available again`;
            }
        };
    }

    /** The global specification of the support packages, found by its name, or created. Two creates at once make one. */
    private supportSpecificationId(req: Request): Promise<string> {
        this.supportSpecification ??= this.findOrCreateSupportSpecification(req).finally(() => {
            this.supportSpecification = undefined;
        });
        return this.supportSpecification;
    }

    private async findOrCreateSupportSpecification(req: Request): Promise<string> {
        const search = `?${new URLSearchParams({ '@type': SUPPORT_SPECIFICATION_TYPE, name: SUPPORT_SPECIFICATION_NAME, limit: '100' }).toString()}`;
        const response = await this.proxy.send(req, { upstream: this.api.upstream, path: '/resourceSpecification', method: 'GET', search });
        if (response.status >= 400) {
            throw new BadGatewayError('It was impossible to check if the software support package spec already exists');
        }
        const found = parseJson(response.body);
        const existing = Array.isArray(found)
            ? (found as unknown[]).find(
                  (item) => isRecord(item) && item['name'] === SUPPORT_SPECIFICATION_NAME && item['@type'] === SUPPORT_SPECIFICATION_TYPE && typeof item['id'] === 'string'
              )
            : undefined;
        if (isRecord(existing)) {
            return existing['id'] as string;
        }
        const created = await this.call(req, 'POST', '/resourceSpecification', SUPPORT_SPECIFICATION, 'It was impossible to create the software support package spec');
        if (typeof created['id'] !== 'string') {
            throw new BadGatewayError('It was impossible to create the software support package spec');
        }
        return created['id'];
    }

    /** A request of the proxy itself to the API, as the caller; it fails with what could not be done when the API does not answer well. */
    private async call(req: Request, method: string, path: string, body: unknown, failure: string): Promise<Record<string, unknown>> {
        const response = await this.proxy.send(req, {
            upstream: this.api.upstream,
            path,
            method,
            search: '',
            ...(body === undefined ? {} : { body: JSON.stringify(body), contentType: 'application/json' })
        });
        if (response.status >= 400) {
            throw new BadGatewayError(failure);
        }
        const answer = parseJson(response.body);
        return isRecord(answer) ? answer : {};
    }
}
