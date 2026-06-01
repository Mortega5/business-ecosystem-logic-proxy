const async = require('async')
const config = require('./../../config')
const utils = require('./../../lib/utils')
const tmfUtils = require('./../../lib/tmfUtils')
const { validateRetrieving, validateOwnerSellerPost, validateNameAndDescription, getPrevVersion, validateOwnerSeller, canRetireSpec } = require('./../../lib/resourceUtils')
const axios = require('axios')

const logger = require('./../../lib/logger').logger.getLogger('TMF')

const ALLOWED_ROLES = [config.roles.customer.toLowerCase(), config.roles.seller.toLowerCase()]
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
            callback({
                status: err.status
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
                const data = response.body
                if (canRetireSpec(data)) {
                    return callback({
                        status: 409,
                        message: `Cannot retire a resource spec without retiring all resources linked with it`
                    })
                }
                callback(null)
            })
        }
        callback(null)
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
        POST: [utils.validateLoggedIn, utils.parseBody, validateOwnerSellerPost, validateNameAndDescription],
        PATCH: [utils.validateLoggedIn, utils.parseBody, getPrevVersion(SW_ENDPOINT), validateUpdate, validateOwnerSeller, validateNameAndDescription],
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
        callback(null)
    };

    return {
        checkPermissions: checkPermissions,
        executePostValidation: executePostValidation
    };
})()

exports.software = software