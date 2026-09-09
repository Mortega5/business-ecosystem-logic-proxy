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
const utils = require('./../../lib/utils')
const tmfUtils = require('./../../lib/tmfUtils')
const axios = require('axios')
const config = require('./../../config')
const equal = require('deep-equal')
const { validateRetrieving, validateOwnerSellerPost, validateNameAndDescription, getPrevVersion, validateOwnerSeller } = require('./../../lib/resourceUtils')

var RETIRED_STATE = 'retired';

const resource = (function (){
    // Resource types DELETE can soft-delete (retire). Add a name here to support it -
    // softDelete resolves the backend path as /<resourceType>/<id>, no new branch needed.
    const softDeletableResources = ['resourceSpecification'];
    const softDeletePattern = new RegExp(`/(${softDeletableResources.join('|')})/([^/]+)/?$`);

    const getResourceAPIUrl = function(path) {
        const resPath = path.replace(`/${config.endpoints.resource.path}/`, '')

        return utils.getAPIURL(
            config.endpoints.resource.appSsl,
            config.endpoints.resource.host,
            config.endpoints.resource.port,
            `${config.endpoints.resource.apiPath}/${resPath}`
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


    const getProductSpecs = function (ref, fields, callback){
        const endpoint = config.endpoints.catalog
        const specPath = `/productSpecification?resourceSpecification.id=${ref}&fields=${fields}`
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
        const body = req.parsedBody
        const prevBody = req.prevBody

        if (body != null && Object.prototype.hasOwnProperty.call(body, 'relatedParty')) {
            const sortParty = (p1, p2) =>
                String(p1?.id).localeCompare(String(p2?.id)) ||
                String(p1?.role).localeCompare(String(p2?.role))

            if (!Array.isArray(body.relatedParty) || !Array.isArray(prevBody.relatedParty) ||
                !equal(prevBody.relatedParty.slice().sort(sortParty), body.relatedParty.slice().sort(sortParty))) {
                return callback({
                    status: 409,
                    message: 'The field "relatedParty" can not be modified'
                })
            }
        }

        // Check the lifecycle updates
        if (body.lifecycleStatus != null && !tmfUtils.isValidStatusTransition(prevBody.lifecycleStatus, body.lifecycleStatus)) {
            // The status is being updated
            return callback({
                status: 400,
                message: `Cannot transition from lifecycle status ${prevBody.lifecycleStatus} to ${body.lifecycleStatus}`
            })
        }
        if (!!prevBody.lifecycleStatus && prevBody.lifecycleStatus.toLowerCase() !== 'retired' &&
        !!body.lifecycleStatus && body.lifecycleStatus.toLowerCase() === 'retired'){
            getProductSpecs(prevBody.id, 'lifecycleStatus', function (err, response){
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
                            message: `Cannot retire a resource spec without retiring all product specs linked with it`
                        })
                    }
                }
            })
        }
        else{
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

        const assetPath = `/${config.endpoints.resource.path}/${match[1]}/${match[2]}`;

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
        POST: [utils.validateLoggedIn, utils.parseBody, validateOwnerSellerPost, validateNameAndDescription],
        PATCH: [utils.validateLoggedIn, utils.parseBody, getPrevVersion(config.endpoints.resource), validateUpdate, validateOwnerSeller, validateNameAndDescription],
        PUT: [utils.methodNotAllowed],
        DELETE: [utils.validateLoggedIn, softDelete]
    };

    var checkPermissions = function(req, callback) {
        var reqValidators = [];

        for (var i in validators[req.method]) {
            reqValidators.push(validators[req.method][i].bind(this, req));
        }

        async.series(reqValidators, callback);
    };

    var executePostValidation = function(response, callback) {
        callback(null)
    };
    return {
        checkPermissions: checkPermissions,
        executePostValidation: executePostValidation
    };
})()

exports.resource = resource;
