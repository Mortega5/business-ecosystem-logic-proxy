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
const { validateRetrieving, validateOwnerSellerPost, validateNameAndDescription, getPrevVersion, validateOwnerSeller } = require('./../../lib/resourceUtils')

const resource = (function (){


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

    const validators = {
        GET: [validateRetrieving],
        POST: [utils.validateLoggedIn, utils.parseBody, validateOwnerSellerPost, validateNameAndDescription],
        PATCH: [utils.validateLoggedIn, utils.parseBody, getPrevVersion(config.endpoints.resource), validateUpdate, validateOwnerSeller, validateNameAndDescription],
        PUT: [utils.methodNotAllowed],
        DELETE: [utils.methodNotAllowed]
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