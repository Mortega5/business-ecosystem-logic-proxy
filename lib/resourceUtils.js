const tmfUtils = require('./tmfUtils');
const utils = require('./utils');
const config = require('./../config');
const async = require('async');
const axios = require('axios');

exports.checkPermissions = function (req, callback) {
    const reqValidators = [];

    for (let i in validators[req.method]) {
        reqValidators.push(validators[req.method][i].bind(this, req));
    }

    async.series(reqValidators, callback);
};

exports.validateRetrieving = function (req, callback) {
    // Check if the request is a list of resources specifications
    if (req.path.endsWith('resourceSpecification') && req.user != null) {
        return tmfUtils.filterRelatedPartyFields(req, () => tmfUtils.ensureRelatedPartyIncluded(req, callback));
    }
    callback(null);
    // validate if a resource specification is returned only by the owner
};

exports.validateOwnerSeller = function (req, callback) {
    if (!tmfUtils.hasPartyRole(req, req.prevBody.relatedParty, config.roles.seller) || !utils.hasRole(req.user, config.roles.seller)) {
        callback({
            status: 403,
            message: 'Unauthorized to update non-owned/non-seller resource specs'
        });
    } else {
        callback(null)
    }
};

exports.validateOwnerSellerPost = function (req, callback) {
    const body = req.parsedBody
    let answer = null;
    if (!tmfUtils.hasPartyRole(req, body.relatedParty, config.roles.seller) || !utils.hasRole(req.user, config.roles.seller)) {
        answer = {
            status: 403,
            message: 'Unauthorized to create non-owned/non-seller resource specs'
        };
    }
    callback(answer)
};


exports.validateNameAndDescription = function (req, callback) {
    const resourceSpec = req.parsedBody
    if (resourceSpec && resourceSpec.name !== null && resourceSpec.name !== undefined) { // resourceSpec.name === '' should enter here
        const errorMessage = tmfUtils.validateNameField(resourceSpec.name, 'Resource spec');
        if (errorMessage) {
            return callback({
                status: 422,
                message: errorMessage
            });
        }
    } else if (resourceSpec && req.method === 'POST') { // resourceSpec.name is null or undefined and it is a POST request
        return callback({
            status: 422,
            message: 'Resource spec name is mandatory'
        });
    }
    if (resourceSpec && resourceSpec.description) {
        const errorMessage = tmfUtils.validateDescriptionField(resourceSpec.description, 'Resource spec');
        if (errorMessage) {
            return callback({
                status: 422,
                message: errorMessage
            });
        }
    }
    callback(null)
}

/**
 * Returns a validator middleware that fetches the current version of a resource before an update.
 * Attaches the fetched resource to `req.prevBody` for use by downstream validators.
 * @param {Object} resourceEndpoint - Endpoint configuration for the resource API
 * @returns {Function} Node-style middleware `(req, callback) => void`
 */
exports.getPrevVersion = function (resourceEndpoint) {
    return (req, callback) => {
        retrieveAsset(resourceEndpoint, req.apiUrl, (err, response) => {
            if (err && err.status === 404) {
                return callback({ status: 404, message: 'The required resource does not exist' });
            }
            if (err) {
                return callback({ status: 500, message: 'The required resource cannot be created/updated' });
            }
            req.prevBody = response.body
            callback(null)
        });
    }
}

exports.canRetireSpec = function (data) {
    return !data || data.some(resource =>
        !['retired', 'obsolete'].includes(resource.lifecycleStatus.toLowerCase())
    )
}
const retrieveAsset = function (resourceEndpoint, path, callback) {
    const uri = getResourceAPIUrl(resourceEndpoint, path);

    axios.get(uri).then((response) => {
        if (response.status >= 400) {
            callback({
                status: response.status
            });
        } else {
            callback(null, {
                status: response.status,
                body: response.data
            });
        }
    }).catch((err) => {
        let errCb = {
            status: err.status
        }

        if (err.response) {
            errCb = {
                status: err.response.status
            }
        }
        callback(errCb);
    })
};

const getResourceAPIUrl = function (resourceEndpoint, path) {
    const resPath = path.replace(`/${resourceEndpoint.path}/`, '')

    return utils.getAPIURL(
        resourceEndpoint.appSsl,
        resourceEndpoint.host,
        resourceEndpoint.port,
        `${resourceEndpoint.apiPath}/${resPath}`
    );
};
