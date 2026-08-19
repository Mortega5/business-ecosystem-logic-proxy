const nock = require('nock');
const proxyquire = require('proxyquire');
const testUtils = require('../../utils');

const RETIRE_ERROR = 'Cannot retire a resource spec without retiring all resources linked with it';

describe('Software API', function() {

    const config = testUtils.getDefaultConfig();
    config.endpoints.software = {
        path: 'software',
        apiPath: '/api',
        host: 'software.com',
        port: '8638',
        appSsl: false
    };

    const SERVER = 'http://' + config.endpoints.software.host + ':' + config.endpoints.software.port;
    const apiPath = config.endpoints.software.apiPath;

    // resourceUtils uses the real tmfUtils and utils, so test data must match their expectations:
    //   - hasPartyRole: compares party.id with req.user.partyId
    //   - hasRole: checks user.roles[].name (not plain strings)
    const seller = {
        id: 'test',
        roles: [{ name: 'Seller' }],
        partyId: 'test'
    };

    const ownerRelatedParty = [{ id: 'test', role: 'Seller' }];
    const otherRelatedParty = [{ id: 'other', role: 'Seller' }];

    const path = '/resourceSpecification';

    const methodNotAllowed = function(req, callback) {
        callback({
            status: 405,
            message: 'The HTTP method ' + req.method + ' is not allowed in the accessed API'
        });
    };

    const parseBody = function(req, callback) {
        try {
            req.parsedBody = JSON.parse(req.body);
            callback(null);
        } catch (e) {
            callback({ status: 400, message: 'The provided body is not a valid JSON' });
        }
    };

    const getSoftwareAPI = function(tmfUtilsMock, utilsMock) {
        return proxyquire('../../../controllers/tmf-apis/software', {
            './../../config': config,
            './../../lib/logger': testUtils.emptyLogger,
            './../../lib/tmfUtils': tmfUtilsMock,
            './../../lib/utils': utilsMock
        }).software;
    };

    beforeEach(function() {
        nock.cleanAll();
    });

    describe('check permissions', function() {

        describe('Not Authenticated Requests', function() {

            const testNotLoggedIn = function(method, done) {
                const utils = {
                    validateLoggedIn: function(req, callback) {
                        callback({ status: 401, message: 'You need to be authenticated to create/update/delete resources' });
                    },
                    methodNotAllowed: methodNotAllowed,
                    parseBody: parseBody
                };

                const softwareApi = getSoftwareAPI({}, utils);
                const req = { method: method, url: path };

                softwareApi.checkPermissions(req, function(err) {
                    expect(err).not.toBe(null);
                    expect(err.status).toBe(401);
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

            it('should not filter related party for non-list paths', function(done) {
                const utils = {
                    validateLoggedIn: function(req, callback) { callback(null); },
                    methodNotAllowed: methodNotAllowed,
                    parseBody: parseBody
                };

                const softwareApi = getSoftwareAPI({}, utils);
                const req = {
                    method: 'GET',
                    path: '/software/resourceSpecification/urn:sw:1',
                    query: {},
                    apiUrl: '/software/resourceSpecification/urn:sw:1',
                    user: { partyId: '1234' }
                };

                softwareApi.checkPermissions(req, function(err) {
                    expect(err).toBe(null);
                    done();
                });
            });

            it('should filter related party for list paths', function(done) {
                const utils = {
                    validateLoggedIn: function(req, callback) { callback(null); },
                    methodNotAllowed: methodNotAllowed,
                    parseBody: parseBody
                };

                const softwareApi = getSoftwareAPI({}, utils);
                const req = {
                    method: 'GET',
                    path: path,
                    query: {},
                    apiUrl: path,
                    user: { partyId: '1234' }
                };

                softwareApi.checkPermissions(req, function(err) {
                    expect(err).toBe(null);
                    // apiUrl is modified to append relatedParty.id filter
                    expect(req.apiUrl).toContain('relatedParty.id=1234');
                    done();
                });
            });
        });

        describe('create', function() {

            function testCreateSpec(body, expectedErr, done) {
                const utils = {
                    validateLoggedIn: function(req, callback) { callback(null); },
                    methodNotAllowed: methodNotAllowed,
                    parseBody: parseBody
                };

                const softwareAPI = getSoftwareAPI({}, utils);
                const req = {
                    user: seller,
                    method: 'POST',
                    body: JSON.stringify(body),
                    apiUrl: '/' + config.endpoints.software.path + path,
                    url: path,
                    hostname: config.endpoints.software.host,
                    headers: {}
                };

                softwareAPI.checkPermissions(req, function(err) {
                    if (!expectedErr) {
                        expect(err).toBe(null);
                    } else {
                        expect(err).toEqual(expectedErr);
                    }
                    done();
                });
            }

            it('should create a software resource specification successfully', function(done) {
                testCreateSpec({
                    id: 'swSpec',
                    name: 'valid name',
                    relatedParty: ownerRelatedParty
                }, null, done);
            });

            it('should raise 422 if the name is too long', function(done) {
                testCreateSpec({
                    id: 'swSpec',
                    name: 'x'.repeat(101),
                    relatedParty: ownerRelatedParty
                }, {
                    status: 422,
                    message: 'Resource spec name is too long, it must be less than 100 characters'
                }, done);
            });

            it('should raise 422 if the description is too long', function(done) {
                testCreateSpec({
                    id: 'swSpec',
                    name: 'valid name',
                    description: 'x'.repeat(100001),
                    relatedParty: ownerRelatedParty
                }, {
                    status: 422,
                    message: 'Resource spec description is too long, it must be less than 100.000 characters'
                }, done);
            });

            it('should raise 422 if name is missing on POST', function(done) {
                testCreateSpec({
                    id: 'swSpec',
                    relatedParty: ownerRelatedParty
                }, {
                    status: 422,
                    message: 'Resource spec name is mandatory'
                }, done);
            });

            it('should raise 403 if the user is not the owner', function(done) {
                testCreateSpec({
                    id: 'swSpec',
                    name: 'valid name',
                    relatedParty: otherRelatedParty
                }, {
                    status: 403,
                    message: 'Unauthorized to create non-owned/non-seller resource specs'
                }, done);
            });

            it('should get/create a SoftwareSupportPackage when creating a SoftwareSpecification', function(done) {
                const specMock = nock(SERVER)
                    .get(apiPath + '/resourceSpecification')
                    .query({ '@type': 'SoftwareSupportPackageSpecification' })
                    .reply(200, [])
                    .post(apiPath + '/resourceSpecification')
                    .reply(201, { id: 'urn:sw:support-spec:1', type: 'SoftwareSupportPackageSpec' });

                const packageMock = nock(SERVER)
                    .post(apiPath + '/resource')
                    .reply(201, { id: 'urn:sw:support-package:1', type: 'SoftwareSupportPackage' });

                const utils = {
                    validateLoggedIn: function(req, callback) { callback(null); },
                    methodNotAllowed: methodNotAllowed,
                    parseBody: parseBody,
                    updateBody: function(req, newBody) { req.body = JSON.stringify(newBody); }
                };

                const softwareAPI = getSoftwareAPI({}, utils);
                const req = {
                    user: seller,
                    method: 'POST',
                    body: JSON.stringify({
                        id: 'swSpec',
                        '@type': 'SoftwareSpecification',
                        name: 'valid name',
                        relatedParty: ownerRelatedParty
                    }),
                    apiUrl: '/' + config.endpoints.software.path + path,
                    url: path,
                    hostname: config.endpoints.software.host,
                    headers: {}
                };

                softwareAPI.checkPermissions(req, function(err) {
                    expect(err).toBe(null);
                    expect(JSON.parse(req.body).softwareSupportPackage).toEqual({ id: 'urn:sw:support-package:1' });
                    specMock.done();
                    packageMock.done();
                    done();
                });
            });
        });

        describe('update', function() {

            function testUpdateSpec(resId, prevBody, body, expectedErr, done, extraNock, isValidTransition) {
                const replyStatus = prevBody.id ? 200 : 404;
                nock(SERVER).get(apiPath + path + '/' + resId).reply(replyStatus, prevBody);

                const transitionResult = isValidTransition !== undefined ? isValidTransition : true;
                const tmfUtils = {
                    isValidStatusTransition: () => transitionResult
                };

                const utils = {
                    validateLoggedIn: (req, callback) => callback(null),
                    methodNotAllowed: methodNotAllowed,
                    parseBody: parseBody
                };

                const softwareAPI = getSoftwareAPI(tmfUtils, utils);
                const req = {
                    user: seller,
                    method: 'PATCH',
                    body: JSON.stringify(body),
                    apiUrl: '/' + config.endpoints.software.path + path + '/' + resId,
                    url: path + '/' + resId,
                    hostname: config.endpoints.software.host,
                    headers: {}
                };

                softwareAPI.checkPermissions(req, function(err) {
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

            it('should allow updating a software resource specification', function(done) {
                testUpdateSpec('urn:sw:1', {
                    id: 'urn:sw:1',
                    lifecycleStatus: 'Active',
                    relatedParty: ownerRelatedParty
                }, { lifecycleStatus: 'Launched' }, null, done);
            });

            it('should raise 400 on an invalid lifecycle status transition', function(done) {
                testUpdateSpec('urn:sw:1', {
                    id: 'urn:sw:1',
                    lifecycleStatus: 'Active',
                    relatedParty: ownerRelatedParty
                }, { lifecycleStatus: 'Retired' }, {
                    status: 400,
                    message: 'Cannot transition from lifecycle status Active to Retired'
                }, done, null, false);
            });

            it('should raise 422 if the name is too long on update', function(done) {
                testUpdateSpec('urn:sw:1', {
                    id: 'urn:sw:1',
                    lifecycleStatus: 'Active',
                    relatedParty: ownerRelatedParty
                }, { lifecycleStatus: 'Launched', name: 'x'.repeat(101) }, {
                    status: 422,
                    message: 'Resource spec name is too long, it must be less than 100 characters'
                }, done);
            });

            it('should raise 422 if the description is too long on update', function(done) {
                testUpdateSpec('urn:sw:1', {
                    id: 'urn:sw:1',
                    lifecycleStatus: 'Active',
                    relatedParty: ownerRelatedParty
                }, { lifecycleStatus: 'Launched', description: 'x'.repeat(100001) }, {
                    status: 422,
                    message: 'Resource spec description is too long, it must be less than 100.000 characters'
                }, done);
            });

            it('should raise 403 if the user is not authorized to update', function(done) {
                testUpdateSpec('urn:sw:1', {
                    id: 'urn:sw:1',
                    lifecycleStatus: 'Active',
                    relatedParty: otherRelatedParty
                }, { lifecycleStatus: 'Launched' }, {
                    status: 403,
                    message: 'Unauthorized to update non-owned/non-seller resource specs'
                }, done);
            });

            it('should raise 404 if the software resource specification is not found', function(done) {
                testUpdateSpec('urn:sw:missing', {}, { lifecycleStatus: 'Launched' }, {
                    status: 404,
                    message: 'The required resource does not exist'
                }, done);
            });

            it('should allow retiring a resourceSpecification when all linked resources are retired', function(done) {
                const resourceMock = nock(SERVER)
                    .get(apiPath + '/resource')
                    .query({ 'resourceSpecification.id': 'urn:sw:1', fields: 'lifecycleStatus' })
                    .reply(200, [{ id: 'res1', lifecycleStatus: 'Retired' }]);

                testUpdateSpec('urn:sw:1', {
                    id: 'urn:sw:1',
                    lifecycleStatus: 'Launched',
                    relatedParty: ownerRelatedParty
                }, { lifecycleStatus: 'Retired' }, null, done, resourceMock);
            });

            it('should raise 409 when retiring a resourceSpecification with active linked resources', function(done) {
                const resourceMock = nock(SERVER)
                    .get(apiPath + '/resource')
                    .query({ 'resourceSpecification.id': 'urn:sw:1', fields: 'lifecycleStatus' })
                    .reply(200, [{ id: 'res1', lifecycleStatus: 'Active' }]);

                testUpdateSpec('urn:sw:1', {
                    id: 'urn:sw:1',
                    lifecycleStatus: 'Launched',
                    relatedParty: ownerRelatedParty
                }, { lifecycleStatus: 'Retired' }, {
                    status: 409,
                    message: RETIRE_ERROR
                }, done, resourceMock);
            });

            it('should patch the linked SoftwareSupportPackage when resourceCharacteristic is updated', function(done) {
                const prevBody = {
                    id: 'urn:sw:1',
                    '@type': 'SoftwareSpecification',
                    lifecycleStatus: 'Active',
                    relatedParty: ownerRelatedParty,
                    softwareSupportPackage: { id: 'urn:sw:support-package:1' }
                };

                nock(SERVER).get(apiPath + path + '/urn:sw:1').reply(200, prevBody);

                const patchMock = nock(SERVER)
                    .patch(apiPath + '/resource/urn:sw:support-package:1', {
                        resourceCharacteristic: [{ name: 'cpu', value: '2' }]
                    })
                    .reply(200, {});

                const utils = {
                    validateLoggedIn: (req, callback) => callback(null),
                    methodNotAllowed: methodNotAllowed,
                    parseBody: parseBody,
                    updateBody: function(req, newBody) { req.body = JSON.stringify(newBody); }
                };

                const softwareAPI = getSoftwareAPI({}, utils);
                const req = {
                    user: seller,
                    method: 'PATCH',
                    body: JSON.stringify({ resourceCharacteristic: [{ name: 'cpu', value: '2' }] }),
                    apiUrl: '/' + config.endpoints.software.path + path + '/urn:sw:1',
                    url: path + '/urn:sw:1',
                    hostname: config.endpoints.software.host,
                    headers: {}
                };

                softwareAPI.checkPermissions(req, function(err) {
                    expect(err).toBe(null);
                    expect(JSON.parse(req.body).resourceCharacteristic).toBeUndefined();
                    patchMock.done();
                    done();
                });
            });

            it('should raise 500 if the software support package cannot be updated', function(done) {
                const prevBody = {
                    id: 'urn:sw:1',
                    '@type': 'SoftwareSpecification',
                    lifecycleStatus: 'Active',
                    relatedParty: ownerRelatedParty,
                    softwareSupportPackage: { id: 'urn:sw:support-package:1' }
                };

                nock(SERVER).get(apiPath + path + '/urn:sw:1').reply(200, prevBody);

                const patchMock = nock(SERVER)
                    .patch(apiPath + '/resource/urn:sw:support-package:1')
                    .reply(500);

                const utils = {
                    validateLoggedIn: (req, callback) => callback(null),
                    methodNotAllowed: methodNotAllowed,
                    parseBody: parseBody,
                    updateBody: function(req, newBody) { req.body = JSON.stringify(newBody); }
                };

                const softwareAPI = getSoftwareAPI({}, utils);
                const req = {
                    user: seller,
                    method: 'PATCH',
                    body: JSON.stringify({ resourceCharacteristic: [{ name: 'cpu', value: '2' }] }),
                    apiUrl: '/' + config.endpoints.software.path + path + '/urn:sw:1',
                    url: path + '/urn:sw:1',
                    hostname: config.endpoints.software.host,
                    headers: {}
                };

                softwareAPI.checkPermissions(req, function(err) {
                    expect(err).toEqual({
                        status: 500,
                        message: 'It was impossible to update the software support package'
                    });
                    patchMock.done();
                    done();
                });
            });

        });

        describe('not allowed methods', function() {

            function testNotAllowedMethod(method, done) {
                const utils = { methodNotAllowed: methodNotAllowed, parseBody: parseBody };
                const softwareApi = getSoftwareAPI({}, utils);
                const req = { method: method };

                softwareApi.checkPermissions(req, function(err) {
                    expect(err.status).toBe(405);
                    expect(err.message).toBe('The HTTP method ' + method + ' is not allowed in the accessed API');
                    done();
                });
            }

            it('should raise 405 for PUT requests', function(done) {
                testNotAllowedMethod('PUT', done);
            });

            it('should raise 405 for DELETE requests', function(done) {
                testNotAllowedMethod('DELETE', done);
            });
        });
    });

    describe('handle API error', function() {

        const getAPIURL = function(ssl, host, port, path) {
            return (ssl ? 'https' : 'http') + '://' + host + ':' + port + path;
        };

        it('should remove the orphan SoftwareSupportPackage when creating a SoftwareSpecification fails', function(done) {
            const deleteMock = nock(SERVER)
                .delete(apiPath + '/resource/urn:sw:support-package:1')
                .reply(204);

            const utils = { getAPIURL: getAPIURL };
            const softwareAPI = getSoftwareAPI({}, utils);

            const response = {
                status: 422,
                method: 'POST',
                reqBody: JSON.stringify({
                    '@type': 'SoftwareSpecification',
                    name: 'valid name',
                    relatedParty: ownerRelatedParty,
                    softwareSupportPackage: { id: 'urn:sw:support-package:1' }
                })
            };

            softwareAPI.handleAPIError(response, function(err) {
                expect(err).toBe(null);
                deleteMock.done();
                done();
            });
        });

        it('should not attempt to delete anything when the failed request has no softwareSupportPackage', function(done) {
            const utils = { getAPIURL: getAPIURL };
            const softwareAPI = getSoftwareAPI({}, utils);

            const response = {
                status: 422,
                method: 'POST',
                reqBody: JSON.stringify({
                    '@type': 'SoftwareSpecification',
                    name: 'valid name',
                    relatedParty: ownerRelatedParty
                })
            };

            softwareAPI.handleAPIError(response, function(err) {
                expect(err).toBe(null);
                expect(nock.pendingMocks().length).toBe(0);
                done();
            });
        });

        it('should not attempt to delete anything when the failed request is not a SoftwareSpecification', function(done) {
            const utils = { getAPIURL: getAPIURL };
            const softwareAPI = getSoftwareAPI({}, utils);

            const response = {
                status: 422,
                method: 'POST',
                reqBody: JSON.stringify({
                    name: 'valid name',
                    relatedParty: ownerRelatedParty,
                    softwareSupportPackage: { id: 'urn:sw:support-package:1' }
                })
            };

            softwareAPI.handleAPIError(response, function(err) {
                expect(err).toBe(null);
                expect(nock.pendingMocks().length).toBe(0);
                done();
            });
        });

        it('should not attempt to delete the SoftwareSupportPackage when a PATCH fails', function(done) {
            const utils = { getAPIURL: getAPIURL };
            const softwareAPI = getSoftwareAPI({}, utils);

            const response = {
                status: 422,
                method: 'PATCH',
                reqBody: JSON.stringify({
                    '@type': 'SoftwareSpecification',
                    name: 'valid name',
                    relatedParty: ownerRelatedParty,
                    softwareSupportPackage: { id: 'urn:sw:support-package:1' }
                })
            };

            softwareAPI.handleAPIError(response, function(err) {
                expect(err).toBe(null);
                expect(nock.pendingMocks().length).toBe(0);
                done();
            });
        });
    });
});
