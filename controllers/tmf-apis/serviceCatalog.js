/* Copyright (c) 2023 Future Internet Consulting and Development Solutions S.L.
 *
 * This file belongs to the business-ecosystem-logic-proxy of the
 * Business API Ecosystem
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

const async = require('async')
const axios = require('axios')
const config = require('./../../config')
const utils = require('./../../lib/utils')
const tmfUtils = require('./../../lib/tmfUtils')

var RETIRED_STATE = 'retired';

const serviceCatalog = (function() {
    // Resource types DELETE can soft-delete (retire). Add a name here to support it -
    // softDelete resolves the backend path as /<resourceType>/<id>, no new branch needed.
    const softDeletableResources = ['serviceSpecification'];
    const softDeletePattern = new RegExp(`/(${softDeletableResources.join('|')})/([^/]+)/?$`);

    const validateRetrieving = function(req, callback) {
        // Check if the request is a list of service specifications
        if (req.path.endsWith('serviceSpecification') && req.user != null) {
            return tmfUtils.filterRelatedPartyFields(req, (err) => {
                if (err) {
                    return callback(err)
                }

                tmfUtils.ensureRelatedPartyIncluded(req, callback)
            });
        } else {
            callback(null);
        }
        // validate if a service specification is returned only by the owner
    };

    const getResourceAPIUrl = function(path) {
        const resPath = path.replace(`/${config.endpoints.service.path}/`, '')

        return utils.getAPIURL(
            config.endpoints.service.appSsl,
            config.endpoints.service.host,
            config.endpoints.service.port,
            `${config.endpoints.service.apiPath}/${resPath}`
        );
    };

    const retrieveAsset = function(path, callback) {
        const uri = getResourceAPIUrl(path);

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

    const getPrevVersion = function(req, callback) {
        retrieveAsset(req.apiUrl, (err, response) => {
            if (err) {
                if (err.status === 404) {
                    callback({
                        status: 404,
                        message: 'The required service does not exist'
                    });
                } else {
                    callback({
                        status: 500,
                        message: 'The required service cannot be created/updated'
                    });
                }
            } else {
                req.prevBody = response.body
                callback(null)
            }
        });
    }

    const parseBody = function (req, callback) {
        try {
            req.parsedBody = JSON.parse(req.body);
        } catch (e) {
            callback({
                status: 400,
                message: 'The provided body is not a valid JSON'
            });

            return; // EXIT
        }
        callback(null)
    }

    const validateOwnerSeller = function(req, callback) {
        if (!tmfUtils.hasPartyRole(req, req.prevBody.relatedParty, config.roles.seller) || !utils.hasRole(req.user, config.roles.seller)) {
            callback({
                status: 403,
                message: 'Unauthorized to update non-owned/non-seller services'
            });
        } else {
            callback(null)
        }
    };

    const validateOwnerSellerPost = function(req, callback) {
        const body = req.parsedBody
        if (!tmfUtils.hasPartyRole(req, body.relatedParty, config.roles.seller) || !utils.hasRole(req.user, config.roles.seller)) {
            callback({
                status: 403,
                message: 'Unauthorized to create non-owned/non-seller service specs'
            });
        } else {
            callback(null)
        }
    };

    const validateFields = function(req, callback) {
        const serviceSpec = req.parsedBody
        if(serviceSpec && serviceSpec.name!==null && serviceSpec.name!==undefined){ // serviceSpec.name === '' should enter here
            const errorMessage = tmfUtils.validateNameField(serviceSpec.name, 'Service spec');
            if (errorMessage) {
                return callback({
                    status: 422,
                    message: errorMessage
                });
            }
        } else if(serviceSpec && req.method === 'POST'){ // serviceSpec.name is null or undefined and it is a POST request
            return callback({
                status: 422,
                message: 'Service spec name is mandatory'
            });
        }
        if (serviceSpec && serviceSpec.description) {
            const errorMessage = tmfUtils.validateDescriptionField(serviceSpec.description, 'Service spec');
            if (errorMessage) {
                return callback({
                    status: 422,
                    message: errorMessage
                });
            }
        }
        callback(null)
    }


    const getServiceSpecs = function (ref, fields, callback){
        const endpoint = config.endpoints.catalog
        const specPath = `/productSpecification?serviceSpecification.id=${ref}&fields=${fields}`
        const uri = utils.getAPIURL(
            endpoint.appSsl,
            endpoint.host,
            endpoint.port,
            `${endpoint.apiPath}${specPath}`
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

    const validateUpdate = function(req, callback) {
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
        if (prevBody.lifecycleStatus && prevBody.lifecycleStatus.toLowerCase() !== 'retired' && 
            body.lifecycleStatus && body.lifecycleStatus.toLowerCase() === 'retired'){

            getServiceSpecs(prevBody.id, 'lifecycleStatus', function (err, response){
                if(err) {
                    callback(err)
                } else {
                    const data = response.body
                    let allRetObs = true
                    for (let prodSpec of data){
                        if(prodSpec.lifecycleStatus.toLowerCase() !== 'retired' && prodSpec.lifecycleStatus.toLowerCase() !== 'obsolete'){
                            allRetObs = false
                            break;
                        }
                    }
                    if(allRetObs){
                        callback(null)
                    }
                    else {
                        callback({
                            status: 409,
                            message: `Cannot retire a service spec without retiring all service specs linked with it`
                        })
                    }
                }
            })
        } else {
            callback(null)
        }
    }

    // DELETE is implemented as a soft delete of one of softDeletableResources: the resource
    // must exist and not already be retired, and the caller must own it. On success the
    // request is rewritten into a PATCH that sets lifecycleStatus to Retired, so the generic
    // proxy forwards that PATCH and the backend's 200 OK response is what reaches the client.
    const softDelete = function(req, callback) {
        const match = req.apiUrl.match(softDeletePattern);

        if (!match) {
            return utils.methodNotAllowed(req, callback);
        }

        const assetPath = `/${config.endpoints.service.path}/${match[1]}/${match[2]}`;

        retrieveAsset(assetPath, function(err, result) {
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

            req.method = 'PATCH';
            req.headers['content-type'] = 'application/json';
            utils.updateBody(req, { lifecycleStatus: 'Retired' });
            callback(null);
        });
    };

    const validators = {
        GET: [validateRetrieving],
        POST: [utils.validateLoggedIn, parseBody, validateOwnerSellerPost, validateFields],
        PATCH: [utils.validateLoggedIn, parseBody, getPrevVersion, validateUpdate, validateOwnerSeller, validateFields],
        PUT: [utils.methodNotAllowed],
        DELETE: [utils.validateLoggedIn, softDelete]
    };

    const checkPermissions = function(req, callback) {
        const reqValidators = [];

        for (let i in validators[req.method]) {
            reqValidators.push(validators[req.method][i].bind(this, req));
        }

        async.series(reqValidators, callback);
    };

    const executePostValidation = function(response, callback) {
        callback(null);
    };

    const handleAPIError = function(res, callback) {
        callback(null);
    };

    return {
        checkPermissions: checkPermissions,
        executePostValidation: executePostValidation,
        handleAPIError: handleAPIError
    }
})();

exports.serviceCatalog = serviceCatalog;
