import { DomainError } from '../../common/domain-error';
import { isRecord } from '../related-party';

export const SUPPORT_SPECIFICATION_TYPE = 'SoftwareSupportPackageSpecification';
export const SUPPORT_SPECIFICATION_NAME = 'Global Software Support Package Specification';

/** The one specification that every software specification's support package refers to, created the first time it is needed. */
export const SUPPORT_SPECIFICATION = {
    name: SUPPORT_SPECIFICATION_NAME,
    '@type': SUPPORT_SPECIFICATION_TYPE,
    '@baseType': 'ResourceSpecification',
    lifecycleStatus: 'Launched',
    resourceSpecCharacteristic: [
        {
            name: 'deploymentDefinition',
            description:
                "Deployment descriptor. The 'type' field drives BPO backend selection: 'helm' triggers helm install/upgrade/uninstall, 'docker' triggers docker run/update/stop.",
            valueType: 'DeploymentDefinition',
            configurable: false,
            minCardinality: 1,
            maxCardinality: 1
        },
        {
            name: 'artifactType',
            description: 'Nature of the deployment artifact. Determines which BPO executor is used.',
            valueType: 'string',
            configurable: false,
            minCardinality: 1,
            maxCardinality: 1,
            resourceSpecCharacteristicValue: [{ isDefault: true, value: 'HelmChart' }, { value: 'DockerCompose' }, { value: 'DockerImage' }]
        },
        {
            name: 'minimumRuntimeVersion',
            description: 'Minimum version of the runtime tool required (e.g. Helm >= 3.10, Docker >= 24.0).',
            valueType: 'string',
            configurable: false,
            minCardinality: 0,
            maxCardinality: 1
        }
    ]
};

// Release identity left the artifact descriptor: a chart carries no release name and no namespace, both are arguments to helm
// install, and keeping them in the package made every deployment of a product reuse one pair
const REMOVED_HELM_IDENTITY_FIELDS = ['releaseName', 'namespace'];

/**
 * The deployment descriptor of the characteristics, when there is one: a type and a properties object, and a helm chart without the
 * release identity. `values` and `enforcedValues` are opaque YAML strings here; that they do not share a key is checked by the portal.
 */
export const validateDeploymentDefinition = (specification: Record<string, unknown>): void => {
    const characteristics = specification['resourceCharacteristic'];
    if (characteristics === undefined || characteristics === null) {
        return;
    }
    if (!Array.isArray(characteristics) || characteristics.some((characteristic: unknown) => !isRecord(characteristic))) {
        throw new DomainError('Invalid resourceCharacteristic format', 400);
    }
    const deployment = (characteristics as Record<string, unknown>[]).find((characteristic) => characteristic['name'] === 'deploymentDefinition');
    const definition = deployment?.['value'];
    if (!definition) {
        return;
    }
    const properties = isRecord(definition) ? definition['properties'] : undefined;
    if (!isRecord(definition) || !definition['type'] || !isRecord(properties)) {
        throw new DomainError('deploymentDefinition must contain a type and a properties object', 422);
    }
    if (definition['type'] === 'helm') {
        const offending = REMOVED_HELM_IDENTITY_FIELDS.filter((field) => field in properties);
        if (offending.length > 0) {
            throw new DomainError(
                `deploymentDefinition.properties must not contain ${offending.join(' or ')}: the release identity is chosen per deployment and travels in the deployment order, not in the package`,
                422
            );
        }
    }
};
