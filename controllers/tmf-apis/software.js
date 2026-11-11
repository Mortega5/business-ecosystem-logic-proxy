const async = require('async')
const config = require('./../../config')
const utils = require('./../../lib/utils')
const tmfUtils = require('./../../lib/tmfUtils')
const { validateRetrieving, validateOwnerSellerPost, validateNameAndDescription, getPrevVersion, validateOwnerSeller, getBlockingResources } = require('./../../lib/resourceUtils')
const axios = require('axios')
const Ajv = require('ajv')
const addFormats = require('ajv-formats')

const logger = require('./../../lib/logger').logger.getLogger('TMF')

const ALLOWED_ROLES = [config.roles.customer.toLowerCase(), config.roles.seller.toLowerCase()]

// Fixed, global SoftwareSupportPackageSpec reused by every SoftwareSpecification
const SUPPORT_PACKAGE_SPEC_NAME = 'Global Software Support Package Specification'
/**
 * Controller to retrieve Software Management (TMF730) TMF API.
 * This controller is responsible for checking permissions and filtering the results of the TMF API calls.
 * It should
 */
const SW_ENDPOINT = config.endpoints.software

const software = (function () {

    // Resource types DELETE can soft-delete (retire). Add a name here to support it -
    // softDelete resolves the backend path as /<resourceType>/<id>, no new branch needed.
    const softDeletableResources = ['resourceSpecification'];
    const softDeletePattern = new RegExp(`/(${softDeletableResources.join('|')})/([^/]+)/?$`);
    var RETIRED_STATE = 'retired';

    const getApiName = function (req) {
        return req.apiUrl.split('/')[2];
    }

    const getResource = function (ref, fields, callback) {
        const specPath = `/resource?resourceSpecification.id=${ref}&fields=${fields}`
        const uri = utils.getAPIURL(
            SW_ENDPOINT.appSsl,
            SW_ENDPOINT.host,
            SW_ENDPOINT.port,
            `${SW_ENDPOINT.apiPath}${specPath}`
        );
        axios.get(uri).then((response) => {
            callback(null, {
                status: response.status,
                body: response.data
            });

        }).catch((err) => {
            let backendMessage = err.message;
            if (err.response) {
                try {
                    backendMessage = JSON.stringify(err.response.data);
                } catch (e) {
                    backendMessage = String(err.response.data);
                }
            }
            callback({
                status: err.response ? err.response.status : 500,
                message: `It was impossible to retrieve the resources linked to the resource spec: ${backendMessage}`
            });
        })
    }

    const validateUpdate = function (req, callback) {
        // Check the lifecycle updates
        const body = req.parsedBody
        const prevBody = req.prevBody

        if (body.lifecycleStatus != null && !tmfUtils.isValidStatusTransition(prevBody.lifecycleStatus, body.lifecycleStatus)) {
            // The status is being updated
            return callback({
                status: 400,
                message: `Cannot transition from lifecycle status ${prevBody.lifecycleStatus} to ${body.lifecycleStatus}`
            })
        }

        const apiName = getApiName(req);
        // If resourceSpec is been retired, check that all linked resources are retired or obsolete
        if (
            apiName === 'resourceSpecification' &&
            !!prevBody.lifecycleStatus && prevBody.lifecycleStatus.toLowerCase() !== 'retired' &&
            !!body.lifecycleStatus && body.lifecycleStatus.toLowerCase() === 'retired'
        ) {
            return getResource(prevBody.id, 'lifecycleStatus', function (err, response) {
                if (err) {
                    return callback(err)
                }
                const blockingResources = getBlockingResources(response.body)
                if (blockingResources.length > 0) {
                    const blockingIds = blockingResources.map(resource => resource.id).join(', ');
                    return callback({
                        status: 409,
                        message: `Cannot retire a resource spec without retiring all resources linked with it (blocked by resources ${blockingIds})`
                    })
                }
                callback(null)
            })
        }
        callback(null)
    }

    const createAsset = function (assetPath, body, callback) {
        const uri = utils.getAPIURL(
            SW_ENDPOINT.appSsl,
            SW_ENDPOINT.host,
            SW_ENDPOINT.port,
            `${SW_ENDPOINT.apiPath}${assetPath}`
        );
        axios.post(uri, body).then((response) => {
            callback(null, {
                status: response.status,
                body: response.data
            });
        }).catch((err) => {
            callback({
                status: err.response ? err.response.status : 500,
                response: err.response ? err.response.data : null
            });
        })
    }

    const retrieveAsset = function (assetPath, callback) {
        const uri = utils.getAPIURL(
            SW_ENDPOINT.appSsl,
            SW_ENDPOINT.host,
            SW_ENDPOINT.port,
            `${SW_ENDPOINT.apiPath}${assetPath}`
        );
        axios.get(uri).then((response) => {
            callback(null, {
                status: response.status,
                body: response.data
            });
        }).catch((err) => {
            callback({
                status: err.response ? err.response.status : 500
            });
        })
    }

    const patchAsset = function (assetPath, body, callback) {
        const uri = utils.getAPIURL(
            SW_ENDPOINT.appSsl,
            SW_ENDPOINT.host,
            SW_ENDPOINT.port,
            `${SW_ENDPOINT.apiPath}${assetPath}`
        );
        axios.patch(uri, body).then((response) => {
            callback(null, {
                status: response.status,
                body: response.data
            });
        }).catch((err) => {
            callback({
                status: err.response ? err.response.status : 500,
                response: err.response ? err.response.data : null
            });
        })
    }

    const deleteAsset = function (assetPath, callback) {
        const uri = utils.getAPIURL(
            SW_ENDPOINT.appSsl,
            SW_ENDPOINT.host,
            SW_ENDPOINT.port,
            `${SW_ENDPOINT.apiPath}${assetPath}`
        );
        axios.delete(uri).then((response) => {
            callback(null, {
                status: response.status
            });
        }).catch((err) => {
            callback({
                status: err.response ? err.response.status : 500
            });
        })
    }

    // Characteristics the global SoftwareSupportPackageSpec must declare. The spec is created once per
    // deployment and then reused, so additions here are reconciled into an existing spec on read.
    const SUPPORT_PACKAGE_SPEC_CHARACTERISTICS = [
        {
            name: "deploymentDefinition",
            description: "Deployment descriptor. 'type' is the kind of artifact being described (helm, docker or " +
                "opennebula) and selects the sub-schema that 'properties' must follow. It does not choose the " +
                "executor: where and how the artifact is deployed is decided by the target environment at " +
                "deployment time.",
            valueType: "DeploymentDefinition",
            configurable: false,
            minCardinality: 1,
            maxCardinality: 1
        },
        {
            name: "artifactType",
            description: "Nature of the deployment artifact. Determines which BPO executor is used.",
            valueType: "string",
            configurable: false,
            minCardinality: 1,
            maxCardinality: 1,
            resourceSpecCharacteristicValue: [
                { isDefault: true, value: "HelmChart" },
                { value: "DockerCompose" },
                { value: "DockerImage" },
                { value: "OpenNebulaResource" }
            ]
        },
        {
            name: "requiredEnvironmentType",
            description: "Kind of target environment the artifact must be deployed on.",
            valueType: "string",
            configurable: false,
            minCardinality: 1,
            maxCardinality: 1,
            resourceSpecCharacteristicValue: [
                { isDefault: true, value: "kubernetes-cluster" },
                { value: "docker-host" },
                { value: "opennebula-cluster" }
            ]
        },
        {
            name: "minimumRuntimeVersion",
            description: "Minimum version of the runtime tool required (e.g. Helm >= 3.10, Docker >= 24.0).",
            valueType: "string",
            configurable: false,
            minCardinality: 0,
            maxCardinality: 1
        }
    ]

    /**
     * Merges the desired characteristics into the ones an existing spec declares. Existing
     * characteristics and values are kept untouched (including extra ones not in the desired list);
     * missing characteristics are appended, and missing values are appended to their characteristic.
     * A desired default is only carried over when the characteristic has no default yet, so a
     * characteristic never ends up with two defaults.
     *
     * @returns {Array|null} the merged list, or null when the existing one is already complete
     */
    const reconcileSpecCharacteristics = function (existingChars) {
        const merged = (existingChars || []).map((char) => Object.assign({}, char))
        let changed = false

        SUPPORT_PACKAGE_SPEC_CHARACTERISTICS.forEach((desired) => {
            const current = merged.find((char) => char.name === desired.name)

            if (!current) {
                merged.push(JSON.parse(JSON.stringify(desired)))
                changed = true
                return
            }

            const desiredValues = desired.resourceSpecCharacteristicValue || []
            if (desiredValues.length === 0) {
                return
            }

            const values = (current.resourceSpecCharacteristicValue || []).slice()
            const hasDefault = values.some((value) => value.isDefault)
            desiredValues.forEach((desiredValue) => {
                if (values.some((value) => value.value === desiredValue.value)) {
                    return
                }
                const added = { value: desiredValue.value }
                if (desiredValue.isDefault && !hasDefault) {
                    added.isDefault = true
                }
                values.push(added)
                changed = true
            })
            current.resourceSpecCharacteristicValue = values
        })

        return changed ? merged : null
    }

    // Brings an existing spec up to date with SUPPORT_PACKAGE_SPEC_CHARACTERISTICS. A failed PATCH is
    // logged but not fatal: support packages only reference the spec by id, so they can still be created.
    const reconcileSupportPackageSpec = function (spec, callback) {
        const merged = reconcileSpecCharacteristics(spec.resourceSpecCharacteristic)

        if (!merged) {
            return callback(null, spec)
        }

        patchAsset(`/resourceSpecification/${spec.id}`, { resourceSpecCharacteristic: merged }, function (err, result) {
            if (err) {
                logger.error(`Could not reconcile SoftwareSupportPackageSpec ${spec.id}: status ${err.status} - ${JSON.stringify(err.response)}`);
                return callback(null, spec)
            }
            logger.debug(`Reconciled the characteristics of SoftwareSupportPackageSpec ${spec.id}`);
            callback(null, result.body && result.body.id ? result.body : Object.assign({}, spec, { resourceSpecCharacteristic: merged }))
        })
    }

    // Gets the single, global SoftwareSupportPackageSpec, creating it on first use
    const getOrCreateSupportPackageSpec = function (callback) {
        const query = `?@type=SoftwareSupportPackageSpecification`

        retrieveAsset(`/resourceSpecification${query}`, function (err, result) {
            if (err) {
                return callback({
                    status: 500,
                    message: 'It was impossible to check if the software support package spec already exists'
                });
            }

            const existing = result.body;
            if (Array.isArray(existing) && existing.length > 0) {
                logger.debug(`Retrieved existing SoftwareSupportPackageSpec ${existing[0].id}`);
                return reconcileSupportPackageSpec(existing[0], callback);
            }

            createAsset('/resourceSpecification', {
                name: SUPPORT_PACKAGE_SPEC_NAME,
                '@type': 'SoftwareSupportPackageSpecification',
                '@baseType': 'ResourceSpecification',
                lifecycleStatus: 'Launched',
                resourceSpecCharacteristic: JSON.parse(JSON.stringify(SUPPORT_PACKAGE_SPEC_CHARACTERISTICS))
            }, function (err, result) {
                if (err) {
                    return callback({
                        status: 500,
                        message: 'It was impossible to create the software support package spec'
                    });
                }
                logger.debug(`Created SoftwareSupportPackageSpec ${result.body.id}`);
                callback(null, result.body);
            });
        });
    }

    const createSupportPackage = function (relatedParty, spec, softwarePackage, callback) {
        createAsset('/resource', {
            name: `Software Support Package for ${softwarePackage.name}`,
            '@type': 'SoftwareSupportPackage',
            '@baseType': 'Resource',
            resourceStatus:'available',
            usageState: 'active',
            resourceSpecification: {id: spec.id},
            resourceCharacteristic: softwarePackage.resourceCharacteristic || [],
            relatedParty: relatedParty,
        }, function (err, result) {
            if (err) {
                return callback({
                    status: 500,
                    message: 'It was impossible to create the software support package'
                });
            }
            logger.debug(`Created SoftwareSupportPackage ${result.body.id}`);
            callback(null, result.body);
        });
    }

    /**
     * When a SoftwareSpecification is being created, gets/creates the global SoftwareSupportPackageSpec,
     * creates a SoftwareSupportPackage referencing it, and attaches its id to the body being created.
     */
    const attachSupportPackage = function (req, callback) {
        const body = req.parsedBody;

        if (!body || body['@type'] !== 'SoftwareSpecification') {
            return callback(null);
        }

        getOrCreateSupportPackageSpec(function (err, spec) {
            if (err) {
                return callback(err);
            }

            createSupportPackage(body.relatedParty, spec, body, function (err, supportPackage) {
                if (err) {
                    return callback(err);
                }
                delete body.resourceCharacteristic
                body.softwareSupportPackage = { id: supportPackage.id };
                utils.updateBody(req, body);
                callback(null);
            });
        });
    }

    /**
     * When a SoftwareSpecification is being updated and the request includes a resourceCharacteristic
     * field, patches that field into the linked SoftwareSupportPackage instead of the spec itself,
     * since the characteristics live on the support package resource.
     */
    const patchSupportPackage = function (req, callback) {
        const body = req.parsedBody;
        const prevBody = req.prevBody;

        if (prevBody['@type'] !== 'SoftwareSpecification' || !body.resourceCharacteristic) {
            return callback(null);
        }

        const packageId = prevBody.softwareSupportPackage && prevBody.softwareSupportPackage.id;
        if (!packageId) {
            return callback(null);
        }

        patchAsset(`/resource/${packageId}`, { resourceCharacteristic: body.resourceCharacteristic }, function (err) {
            if (err) {
                return callback({
                    status: 500,
                    message: 'It was impossible to update the software support package'
                });
            }
            delete body.resourceCharacteristic;
            utils.updateBody(req, body);
            callback(null);
        });
    }

    /**
     * Validates that the user is allowed to create a software resource.
     * @param {Object} req - Incoming HTTP request with user context and parsed body
     * @param {Function} callback - Node-style callback: callback(err) where err is null on success or an object with {status, message} on failure
     */
    const validateCreation = function (req, callback) {

        let body;

        // The request body may not be well formed
        try {
            body = JSON.parse(req.body);
        } catch (e) {
            return callback({
                status: 400,
                message: 'The resource is not a valid JSON document'
            });
        }

        // Check that the related party field has been included
        if (!body.relatedParty) {
            return callback({
                status: 400,
                message: 'A product order must contain a relatedParty field'
            });
        }
        callback(null)
    }

    // Release identity left the artifact descriptor: a chart carries no release name and no namespace,
    // both are arguments to helm install. Keeping them here also meant every deployment of a product
    // reused one pair, so a subscription could not host a second deployment without colliding.
    const REMOVED_HELM_IDENTITY_FIELDS = ['releaseName', 'namespace']

    // Kinds of artifact a deploymentDefinition can describe (the deployment-definition schema `type` enum)
    const DEPLOYMENT_DEFINITION_TYPES = ['helm', 'docker', 'opennebula']

    // Packages published before the schemas moved to GitLab Pages point their @schemaLocation at these
    // gists. They are still accepted so those packages can be edited, but are not fetched or validated.
    const LEGACY_SCHEMA_PREFIXES = ['https://gist.githubusercontent.com/vramperez/']

    const MAX_REPORTED_SCHEMA_ERRORS = 5
    const SCHEMA_FETCH_TIMEOUT_MS = 10000

    // Compiled validators per schema URL. Allow-listed schema versions are immutable, so an entry never
    // goes stale; it holds the pending promise so concurrent requests share a single fetch.
    const schemaValidators = new Map()

    const normalizeUrl = function (location) {
        try {
            return new URL(location).href
        } catch (e) {
            return null
        }
    }

    const isAllowedSchemaLocation = function (location) {
        const normalized = normalizeUrl(location)
        if (!normalized) {
            return false
        }
        if (config.deploymentDefinitionSchema && normalized === normalizeUrl(config.deploymentDefinitionSchema)) {
            return true
        }
        return (config.schemaBaseAllowList || []).some((prefix) => normalized.startsWith(prefix))
    }

    const isLegacySchemaLocation = function (location) {
        return LEGACY_SCHEMA_PREFIXES.some((prefix) => location.startsWith(prefix))
    }

    /**
     * Fetches and compiles the JSON Schema at the given URL, caching the result. Rejects with an error
     * carrying the HTTP status to return: 503 when the schema cannot be fetched (validation is never
     * skipped), 500 when what was fetched is not a usable schema.
     */
    const getSchemaValidator = function (location) {
        if (schemaValidators.has(location)) {
            return schemaValidators.get(location)
        }

        const pending = axios.get(location, { timeout: SCHEMA_FETCH_TIMEOUT_MS, responseType: 'text' })
            .catch((err) => {
                throw {
                    status: 503,
                    message: `The deploymentDefinition schema ${location} could not be retrieved, try again later`,
                    cause: err.message
                }
            })
            .then((response) => {
                try {
                    const schema = typeof response.data === 'string' ? JSON.parse(response.data) : response.data
                    // One Ajv instance per schema: two URLs may serve documents with the same $id
                    const ajv = new Ajv({ strict: false, allErrors: true })
                    addFormats(ajv)
                    return ajv.compile(schema)
                } catch (e) {
                    throw {
                        status: 500,
                        message: `The deploymentDefinition schema ${location} is not a valid JSON Schema`,
                        cause: e.message
                    }
                }
            })

        schemaValidators.set(location, pending)
        // A failed fetch or compilation must not be cached: the next request tries again
        pending.catch(() => schemaValidators.delete(location))
        return pending
    }

    /**
     * Picks the errors worth showing. The deployment-definition schema is a oneOf keyed on `type`, so
     * ajv also reports every branch the value was never meant to match. Branches that fail a `const`
     * (the discriminator) are dropped together with the oneOf/if summary errors; if nothing is left the
     * raw list is used.
     */
    const describeSchemaErrors = function (errors) {
        const branchOf = (error) => {
            const match = error.schemaPath.match(/^#\/oneOf\/(\d+)\//)
            return match ? match[1] : null
        }
        const mismatchedBranches = new Set(errors
            .filter((error) => error.keyword === 'const' && branchOf(error) !== null)
            .map(branchOf))

        let relevant = errors.filter((error) =>
            !['oneOf', 'anyOf', 'if'].includes(error.keyword) && !mismatchedBranches.has(branchOf(error)))
        if (relevant.length === 0) {
            relevant = errors
        }

        return relevant.slice(0, MAX_REPORTED_SCHEMA_ERRORS).map((error) => {
            const extra = error.params && error.params.additionalProperty ? ` (${error.params.additionalProperty})` : ''
            return `${error.instancePath || '/'} ${error.message}${extra}`
        }).join('; ')
    }

    /**
     * Validates the deploymentDefinition characteristic of a software package, when present:
     *  - structural checks: a known `type` and a `properties` object;
     *  - helm definitions must not carry the release identity (releaseName/namespace);
     *  - when the characteristic declares an `@schemaLocation`, the value is validated against that
     *    JSON Schema. The location must be allow-listed (config.schemaBaseAllowList or exactly
     *    config.deploymentDefinitionSchema), since the proxy fetches it. Legacy gist locations are
     *    accepted without schema validation.
     *
     * The two provider value channels of helm (`values` and `enforcedValues`) are opaque YAML strings;
     * checking that a key does not appear in both needs a YAML parser this service does not have, so
     * that check lives in the UI for now.
     *
     * @param {Object} req - Incoming HTTP request, body already parsed into req.parsedBody by utils.parseBody
     * @param {Function} callback - callback(err) with {status, message} on failure
     */
    const validateDeploymentDefinition = function (req, callback) {
        const body = req.parsedBody
        const chars = (body && Array.isArray(body.resourceCharacteristic)) ? body.resourceCharacteristic : []
        const deployment = chars.find((char) => char && char.name === 'deploymentDefinition')

        if (!deployment || !deployment.value) {
            return callback(null)
        }

        const definition = deployment.value
        if (!definition.type || !definition.properties || typeof definition.properties !== 'object') {
            return callback({
                status: 422,
                message: 'deploymentDefinition must contain a type and a properties object'
            })
        }

        if (!DEPLOYMENT_DEFINITION_TYPES.includes(definition.type)) {
            return callback({
                status: 422,
                message: `deploymentDefinition.type must be one of ${DEPLOYMENT_DEFINITION_TYPES.join(', ')}`
            })
        }

        if (definition.type === 'helm') {
            const offending = REMOVED_HELM_IDENTITY_FIELDS.filter((field) => field in definition.properties)
            if (offending.length > 0) {
                return callback({
                    status: 422,
                    message: `deploymentDefinition.properties must not contain ${offending.join(' or ')}: ` +
                        'the release identity is chosen per deployment and travels in the deployment order, ' +
                        'not in the package'
                })
            }
        }

        const location = deployment['@schemaLocation']
        if (!location) {
            return callback(null)
        }

        if (typeof location === 'string' && isLegacySchemaLocation(location)) {
            logger.debug(`Accepting deploymentDefinition with legacy @schemaLocation ${location} without schema validation`)
            return callback(null)
        }

        if (typeof location !== 'string' || !isAllowedSchemaLocation(location)) {
            return callback({
                status: 422,
                message: `deploymentDefinition @schemaLocation ${location} is not an allowed schema location; ` +
                    `use ${config.deploymentDefinitionSchema}`
            })
        }

        getSchemaValidator(location).then((validate) => {
            if (validate(definition)) {
                return callback(null)
            }
            callback({
                status: 422,
                message: `deploymentDefinition does not match the schema ${location}: ${describeSchemaErrors(validate.errors)}`
            })
        }, (err) => {
            logger.error(`${err.message}: ${err.cause}`)
            callback({ status: err.status, message: err.message })
        })
    }

    /**
     * DELETE is implemented as a soft delete of one of softDeletableResources: the resource
     * must exist and not already be retired, and the caller must own it. When the resource is
     * a SoftwareSpecification, its linked SoftwareSupportPackage is retired too, since it has
     * no meaning once the spec it supports is gone. On success the request is rewritten into
     * a PATCH that sets lifecycleStatus to Retired, so the generic proxy forwards that PATCH
     * and the backend's 200 OK response is what reaches the client.
     */
    const softDelete = function (req, callback) {
        const match = req.apiUrl.match(softDeletePattern);

        if (!match) {
            return utils.methodNotAllowed(req, callback);
        }

        const assetPath = `/${match[1]}/${match[2]}`;

        retrieveAsset(assetPath, function (err, result) {
            if (err) {
                if (err.status === 404) {
                    return callback({
                        status: 404,
                        message: 'The required resource does not exist'
                    });
                }
                return callback({
                    status: 500,
                    message: 'The TMForum APIs fails to retrieve the object you are trying to delete'
                });
            }

            const previousBody = result.body;

            if (!tmfUtils.isOwner(req, previousBody)) {
                return callback({
                    status: 403,
                    message: 'The user making the request is not the owner of the accessed resource'
                });
            }

            const lifecycleStatus = previousBody.lifecycleStatus ? previousBody.lifecycleStatus.toLowerCase() : '';

            if (lifecycleStatus === RETIRED_STATE) {
                return callback({
                    status: 409,
                    message: 'The resource is already retired'
                });
            }

            const finishSoftDelete = function () {
                req.method = 'PATCH';
                req.headers['content-type'] = 'application/json';
                utils.updateBody(req, { lifecycleStatus: 'Retired' });
                callback(null);
            };

            const packageId = previousBody.softwareSupportPackage && previousBody.softwareSupportPackage.id;
            if (!packageId) {
                return finishSoftDelete();
            }

            patchAsset(`/resource/${packageId}`, { resourceStatus: 'suspended', usageState: 'idle' }, function (err) {
                if (err) {
                    logger.error(`Could not retire SoftwareSupportPackage ${packageId}: status ${err.status} - ${JSON.stringify(err.response)}`);
                    return callback({
                        status: 500,
                        message: 'It was impossible to retire the linked software support package'
                    });
                }
                finishSoftDelete();
            });
        });
    };

    const validators = {
        GET: [validateRetrieving],
        POST: [utils.validateLoggedIn, utils.parseBody, validateOwnerSellerPost, validateNameAndDescription, validateDeploymentDefinition, attachSupportPackage],
        PATCH: [utils.validateLoggedIn, utils.parseBody, getPrevVersion(SW_ENDPOINT), validateUpdate, validateOwnerSeller, validateNameAndDescription, validateDeploymentDefinition, patchSupportPackage],
        PUT: [utils.methodNotAllowed],
        DELETE: [utils.validateLoggedIn, softDelete]
    };

    const checkPermissions = function (req, callback) {
        const reqValidators = [];

        const methodValidators = validators[req.method] || [];
        methodValidators.forEach(validator => reqValidators.push(validator.bind(this, req)));

        async.series(reqValidators, callback);
    };

    const executePostValidation = function (response, callback) {

        callback(null);
    };

    /**
     * When the proxied POST for a SoftwareSpecification fails on the backend, removes the
     * SoftwareSupportPackage created by attachSupportPackage so it doesn't stay as orphan garbage.
     */
    const handleAPIError = function (response, callback) {
        if (response.method !== 'POST') {
            return callback(null);
        }

        let body;
        try {
            body = JSON.parse(response.reqBody);
        } catch (e) {
            return callback(null);
        }

        const packageId = body && body['@type'] === 'SoftwareSpecification' && body.softwareSupportPackage
            ? body.softwareSupportPackage.id
            : null;

        if (!packageId) {
            return callback(null);
        }

        deleteAsset(`/resource/${packageId}`, function (err) {
            if (err) {
                logger.error(`Could not remove orphan SoftwareSupportPackage ${packageId}`);
            } else {
                logger.debug(`Removed orphan SoftwareSupportPackage ${packageId}`);
            }
            callback(null);
        });
    };

    return {
        checkPermissions: checkPermissions,
        executePostValidation: executePostValidation,
        handleAPIError: handleAPIError
    };
})()

exports.software = software