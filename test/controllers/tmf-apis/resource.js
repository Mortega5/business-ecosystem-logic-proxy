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

const nock = require('nock');
const proxyquire = require('proxyquire');
const testUtils = require('../../utils');
const realUtils = require('../../../lib/utils');
const realTmfUtils = require('../../../lib/tmfUtils');

const RETIRE_ERROR = 'Cannot retire a resource spec without retiring all product specs linked with it'

describe('ResourceSpecification API', function() {

    const config = testUtils.getDefaultConfig();
    const SERVER =
        (config.endpoints.resource.appSsl ? 'https' : 'http') +
        '://' +
        config.endpoints.resource.host +
        ':' +
        config.endpoints.resource.port;

    const getResourceSpecAPI = function(tmfUtils, utils) {
        return proxyquire('../../../controllers/tmf-apis/resource', {
            './../../config': config,
            './../../lib/logger': testUtils.emptyLogger,
            './../../lib/tmfUtils': tmfUtils,
            './../../lib/utils': utils
        }).resource;
    };

    // Builds a utils mock using real implementations, overriding only validateLoggedIn.
    const makeUtils = function(validateLoggedIn) {
        return Object.assign({}, realUtils, {
            validateLoggedIn: validateLoggedIn || function(req, cb) { cb(null); }
        });
    };

    // Only isValidStatusTransition is needed from tmfUtils in resource.js itself (validateUpdate).
    // All other tmfUtils calls go through resourceUtils.js which uses the real module directly.
    const makeTmfUtils = function() {
        return { isValidStatusTransition: realTmfUtils.isValidStatusTransition };
    };

    const individual = '/party/individual/resourceSpec';
    const path = '/resourceSpecification';
    const apiPath = '/api';

    const seller = {
        id: 'test',
        roles: [{ name: 'Seller' }],
        partyId: 'test'
    };

    const protocol = config.endpoints.catalog.appSsl ? 'https' : 'http';
    const url = protocol + '://' + config.endpoints.resource.host + ':' + config.endpoints.resource.port;
    const prodSpecUrl = protocol + '://' + config.endpoints.catalog.host + ':' + config.endpoints.catalog.port;

    beforeEach(function() {
        nock.cleanAll();
    });

    describe('check permissions', function() {

        describe('Not Authenticated Requests', function() {

            const testNotLoggedIn = function(method, done) {
                const utils = makeUtils(function(req, callback) {
                    callback({ status: 401, message: 'You need to be authenticated to create/update/delete resources' });
                });

                const resourceApi = getResourceSpecAPI(makeTmfUtils(), utils);
                const req = { method: method, url: path };

                resourceApi.checkPermissions(req, function(err) {
                    expect(err).not.toBe(null);
                    expect(err.status).toBe(401);
                    expect(err.message).toBe('You need to be authenticated to create/update/delete resources');
                    done();
                });
            };

            it('should reject not authenticated POST requests', function(done) {
                testNotLoggedIn('POST', done);
            });

            it('should reject not authenticated PATCH requests', function(done) {
                testNotLoggedIn('PATCH', done);
            });
        });

        describe('retrieval', function() {

            it('should not filter for non-list paths', function(done) {
                const resourceApi = getResourceSpecAPI(makeTmfUtils(), makeUtils());
                const req = {
                    method: 'GET',
                    query: {},
                    path: '/test',
                    apiUrl: '/test',
                    user: { partyId: '1234' }
                };

                resourceApi.checkPermissions(req, function(err) {
                    expect(err).toBe(null);
                    expect(req.apiUrl).toBe('/test');
                    done();
                });
            });

            it('should append relatedParty.id filter for list paths', function(done) {
                const resourceApi = getResourceSpecAPI(makeTmfUtils(), makeUtils());
                const req = {
                    method: 'GET',
                    query: {},
                    path: path,
                    apiUrl: path,
                    user: { partyId: '1234' }
                };

                resourceApi.checkPermissions(req, function(err) {
                    expect(err).toBe(null);
                    expect(req.apiUrl).toContain('relatedParty.id=1234');
                    done();
                });
            });
        });

        describe('create', () => {

            function testCreateSpec(body, expectedErr, done) {
                const resourceAPI = getResourceSpecAPI(makeTmfUtils(), makeUtils());

                const req = {
                    user: seller,
                    method: 'POST',
                    body: JSON.stringify(body),
                    apiUrl: `/${config.endpoints.resource.path}${path}`,
                    url: path,
                    hostname: config.endpoints.service.host,
                    headers: {}
                };

                resourceAPI.checkPermissions(req, (err) => {
                    if (!expectedErr) {
                        expect(err).toBe(null);
                    } else {
                        expect(err).toEqual(expectedErr);
                    }
                    done();
                });
            }

            it('should create a resource specification successfully', (done) => {
                testCreateSpec({
                    id: 'resSpec',
                    name: 'name',
                    validFor: { startDateTime: '2016-07-12T10:56:00' },
                    relatedParty: [{ id: 'test', role: 'Seller', href: SERVER + individual }]
                }, null, done);
            });

            it('should raise 422 if name is too long', (done) => {
                testCreateSpec({
                    id: 'resSpec',
                    name: 'x'.repeat(101),
                    relatedParty: [{ id: 'test', role: 'Seller', href: SERVER + individual }]
                }, { status: 422, message: 'Resource spec name is too long, it must be less than 100 characters' }, done);
            });

            it('should raise 422 if description is too long', (done) => {
                testCreateSpec({
                    id: 'resSpec',
                    name: 'name',
                    description: 'x'.repeat(100001),
                    relatedParty: [{ id: 'test', role: 'Seller', href: SERVER + individual }]
                }, { status: 422, message: 'Resource spec description is too long, it must be less than 100.000 characters' }, done);
            });

            it('should raise a 403 unauthorized error if the user is not the owner', (done) => {
                testCreateSpec({
                    id: 'resspec',
                    name: 'name',
                    validFor: { startDateTime: '2016-07-12T10:56:00' },
                    relatedParty: [{ id: 'test3', role: 'Seller', href: SERVER + individual }]
                }, { status: 403, message: 'Unauthorized to create non-owned/non-seller resource specs' }, done);
            });

            it('should raise an error if the body is not valid', (done) => {
                const resourceAPI = getResourceSpecAPI(makeTmfUtils(), makeUtils());

                const req = {
                    user: seller,
                    method: 'POST',
                    body: 'invalid',
                    apiUrl: `/${config.endpoints.resource.path}${path}`,
                    url: path,
                    hostname: config.endpoints.service.host,
                    headers: {}
                };

                resourceAPI.checkPermissions(req, (err) => {
                    expect(err).toEqual({ status: 400, message: 'The provided body is not a valid JSON' });
                    done();
                });
            });
        });

        describe('update', () => {

            function testUpdateSpec(resId, prevBody, body, expectedErr, done, extraNock) {
                nock(url).get(`${apiPath}${path}/${resId}`).reply(200, prevBody);

                const serviceAPI = getResourceSpecAPI(makeTmfUtils(), makeUtils());
                const req = {
                    user: seller,
                    method: 'PATCH',
                    body: JSON.stringify(body),
                    apiUrl: `/${config.endpoints.resource.path}${path}/${resId}`,
                    url: `${path}/${resId}`,
                    hostname: config.endpoints.service.host,
                    headers: {}
                };

                serviceAPI.checkPermissions(req, (err) => {
                    if (!expectedErr) {
                        expect(err).toBe(null);
                    } else {
                        expect(err).toEqual(expectedErr);
                    }
                    if (extraNock) {
                        extraNock.done();
                    }
                    done();
                });
            }

            const ownerPrevBody = {
                id: 'urn:resource-spec:1',
                lifecycleStatus: 'Active',
                relatedParty: [{ id: 'test', role: 'Seller' }]
            };

            it('should allow to update a resource specification', (done) => {
                testUpdateSpec('urn:resource-spec:1', ownerPrevBody, { lifecycleStatus: 'Launched' }, null, done);
            });

            it('should allow to retire a resource specification', (done) => {
                const prodSpecMock = nock(prodSpecUrl)
                    .get(apiPath + '/productSpecification')
                    .query({ 'resourceSpecification.id': 'urn:resource-spec:1', fields: 'lifecycleStatus' })
                    .reply(200, [{ id: 'prod', lifecycleStatus: 'Obsolete' }]);

                testUpdateSpec('urn:resource-spec:1', {
                    id: 'urn:resource-spec:1',
                    lifecycleStatus: 'Launched',
                    relatedParty: [{ id: 'test', role: 'Seller' }]
                }, { lifecycleStatus: 'Retired' }, null, done, prodSpecMock);
            });

            it('should raise 422 if name is too long', (done) => {
                testUpdateSpec('urn:resource-spec:1', ownerPrevBody,
                    { lifecycleStatus: 'Launched', name: 'x'.repeat(101) },
                    { status: 422, message: 'Resource spec name is too long, it must be less than 100 characters' },
                    done);
            });

            it('should raise 422 if description is too long', (done) => {
                testUpdateSpec('urn:resource-spec:1', ownerPrevBody,
                    { lifecycleStatus: 'Launched', name: 'name', description: 'x'.repeat(100001) },
                    { status: 422, message: 'Resource spec description is too long, it must be less than 100.000 characters' },
                    done);
            });

            it('should raise 409 if product specs linked are not retired', (done) => {
                const prodSpecMock = nock(prodSpecUrl)
                    .get(apiPath + '/productSpecification')
                    .query({ 'resourceSpecification.id': 'urn:resource-spec:1', fields: 'lifecycleStatus' })
                    .reply(200, [{ id: 'prod', lifecycleStatus: 'Active' }]);

                testUpdateSpec('urn:resource-spec:1', {
                    id: 'urn:resource-spec:1',
                    lifecycleStatus: 'Launched',
                    relatedParty: [{ id: 'test', role: 'Seller' }]
                }, { lifecycleStatus: 'Retired' }, { status: 409, message: RETIRE_ERROR }, done, prodSpecMock);
            });

            it('should raise a 403 if the user is not authorized to update', (done) => {
                testUpdateSpec('urn:resource-spec:1', {
                    id: 'urn:resource-spec:1',
                    lifecycleStatus: 'Active',
                    relatedParty: [{ id: 'test3', role: 'Seller' }]
                }, { lifecycleStatus: 'Launched' },
                { status: 403, message: 'Unauthorized to update non-owned/non-seller resource specs' },
                done);
            });

            it('should raise a 404 error if the resource specification is not found', (done) => {
                nock(url).get(`${apiPath}${path}/urn:resource-spec:2`).reply(404, {});

                const serviceAPI = getResourceSpecAPI(makeTmfUtils(), makeUtils());
                const req = {
                    user: seller,
                    method: 'PATCH',
                    body: JSON.stringify({ lifecycleStatus: 'Launched' }),
                    apiUrl: `/${config.endpoints.resource.path}${path}/urn:resource-spec:2`,
                    url: `${path}/urn:resource-spec:2`,
                    hostname: config.endpoints.service.host,
                    headers: {}
                };

                serviceAPI.checkPermissions(req, (err) => {
                    expect(err).toEqual({ status: 404, message: 'The required resource does not exist' });
                    done();
                });
            });

            it('should raise a 400 error if an invalid lifecycle transition is provided', (done) => {
                testUpdateSpec('urn:resource-spec:1', ownerPrevBody,
                    { lifecycleStatus: 'Retired' },
                    { status: 400, message: 'Cannot transition from lifecycle status Active to Retired' },
                    done);
            });
        });

        describe('not allowed method', function() {

            function testNotAllowedMethod(method, done) {
                const resourceApi = getResourceSpecAPI(makeTmfUtils(), makeUtils());
                const req = { method: method };

                resourceApi.checkPermissions(req, function(err) {
                    expect(err.status).toBe(405);
                    expect(err.message).toBe('The HTTP method ' + method + ' is not allowed in the accessed API');
                    done();
                });
            }

            it('should raise 405 for PUT', function(done) {
                testNotAllowedMethod('PUT', done);
            });

            it('should raise 405 for DELETE', function(done) {
                testNotAllowedMethod('DELETE', done);
            });
        });
    });
});
