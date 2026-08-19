const async = require('async')
const config = require('./../../config')
const utils = require('./../../lib/utils')
const tmfUtils = require('./../../lib/tmfUtils')
const { validateRetrieving, validateOwnerSellerPost, validateNameAndDescription, getPrevVersion, validateOwnerSeller, getBlockingResources } = require('./../../lib/resourceUtils')
const axios = require('axios')

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
                return callback(null, existing[0]);
            }

            createAsset('/resourceSpecification', {
                name: SUPPORT_PACKAGE_SPEC_NAME,
                '@type': 'SoftwareSupportPackageSpecification',
                '@baseType': 'ResourceSpecification',
                lifecycleStatus: 'Launched',
                resourceSpecCharacteristic: [
                    {
                        name: "deploymentDefinition",
                        description: "Deployment descriptor. The 'type' field drives BPO backend selection: 'helm' triggers helm install/upgrade/uninstall, 'docker' triggers docker run/update/stop.",
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
                            { value: "DockerImage" }
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


    const validators = {
        GET: [validateRetrieving],
        POST: [utils.validateLoggedIn, utils.parseBody, validateOwnerSellerPost, validateNameAndDescription, attachSupportPackage],
        PATCH: [utils.validateLoggedIn, utils.parseBody, getPrevVersion(SW_ENDPOINT), validateUpdate, validateOwnerSeller, validateNameAndDescription, patchSupportPackage],
        PUT: [utils.methodNotAllowed],
        DELETE: [utils.methodNotAllowed]
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