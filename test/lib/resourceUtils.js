const nock = require('nock');
const testUtils = require('../utils');
const resourceUtils = require('../../lib/resourceUtils');

describe('resourceUtils', function() {

    const config = testUtils.getDefaultConfig();

    const resourceEndpoint = config.endpoints.resource;
    const SERVER = 'http://' + resourceEndpoint.host + ':' + resourceEndpoint.port;
    const API_PATH = resourceEndpoint.apiPath;

    const seller = {
        id: 'test',
        roles: [{ name: 'Seller' }],
        partyId: 'test'
    };

    const ownerRelatedParty = [{ id: 'test', role: 'Seller' }];
    const otherRelatedParty = [{ id: 'other', role: 'Seller' }];

    beforeEach(function() {
        nock.cleanAll();
    });

    // ─── validateRetrieving ───────────────────────────────────────────────────

    describe('validateRetrieving', function() {

        it('should append relatedParty.id filter for list paths', function(done) {
            const req = {
                path: '/resourceSpecification',
                query: {},
                apiUrl: '/resourceSpecification',
                user: { partyId: 'test' }
            };

            resourceUtils.validateRetrieving(req, function(err) {
                expect(err).toBe(null);
                expect(req.apiUrl).toContain('relatedParty.id=test');
                done();
            });
        });

        it('should not filter for non-list paths', function(done) {
            const req = {
                path: '/resourceSpecification/urn:spec:1',
                query: {},
                apiUrl: '/resourceSpecification/urn:spec:1',
                user: { partyId: 'test' }
            };

            const originalApiUrl = req.apiUrl;
            resourceUtils.validateRetrieving(req, function(err) {
                expect(err).toBe(null);
                expect(req.apiUrl).toBe(originalApiUrl);
                done();
            });
        });

        it('should skip filtering when user is null', function(done) {
            const req = {
                path: '/resourceSpecification',
                query: {},
                apiUrl: '/resourceSpecification',
                user: null
            };

            const originalApiUrl = req.apiUrl;
            resourceUtils.validateRetrieving(req, function(err) {
                expect(err).toBe(null);
                expect(req.apiUrl).toBe(originalApiUrl);
                done();
            });
        });

        it('should return 403 if filtering by relatedParty.href', function(done) {
            const req = {
                path: '/resourceSpecification',
                query: { 'relatedParty.href': 'http://some-party' },
                apiUrl: '/resourceSpecification',
                user: { partyId: 'test' }
            };

            resourceUtils.validateRetrieving(req, function(err) {
                expect(err.status).toBe(403);
                done();
            });
        });

        it('should return 403 if relatedParty.id filter belongs to another user', function(done) {
            const req = {
                path: '/resourceSpecification',
                query: { 'relatedParty.id': 'other-user' },
                apiUrl: '/resourceSpecification',
                user: { partyId: 'test' }
            };

            resourceUtils.validateRetrieving(req, function(err) {
                expect(err.status).toBe(403);
                done();
            });
        });

        it('should allow filtering by own relatedParty.id', function(done) {
            const req = {
                path: '/resourceSpecification',
                query: { 'relatedParty.id': 'test' },
                apiUrl: '/resourceSpecification',
                user: { partyId: 'test' }
            };

            resourceUtils.validateRetrieving(req, function(err) {
                expect(err).toBe(null);
                done();
            });
        });

        it('should ensure relatedParty is included in fields query', function(done) {
            const req = {
                path: '/resourceSpecification',
                query: { fields: 'name,description' },
                apiUrl: '/resourceSpecification?fields=name,description',
                user: { partyId: 'test' }
            };

            resourceUtils.validateRetrieving(req, function(err) {
                expect(err).toBe(null);
                expect(req.apiUrl).toContain('relatedParty');
                done();
            });
        });
    });

    // ─── validateOwnerSellerPost ──────────────────────────────────────────────

    describe('validateOwnerSellerPost', function() {

        function buildReq(user, relatedParty) {
            return {
                user: user,
                parsedBody: { relatedParty: relatedParty }
            };
        }

        it('should allow when user is owner and has seller role', function(done) {
            const req = buildReq(seller, ownerRelatedParty);

            resourceUtils.validateOwnerSellerPost(req, function(err) {
                expect(err).toBe(null);
                done();
            });
        });

        it('should return 403 when user is not the owner', function(done) {
            const req = buildReq(seller, otherRelatedParty);

            resourceUtils.validateOwnerSellerPost(req, function(err) {
                expect(err.status).toBe(403);
                expect(err.message).toBe('Unauthorized to create non-owned/non-seller resource specs');
                done();
            });
        });

        it('should return 403 when user does not have seller role', function(done) {
            const nonSeller = { id: 'test', roles: [{ name: 'Buyer' }], partyId: 'test' };
            const req = buildReq(nonSeller, ownerRelatedParty);

            resourceUtils.validateOwnerSellerPost(req, function(err) {
                expect(err.status).toBe(403);
                done();
            });
        });
    });

    // ─── validateOwnerSeller ─────────────────────────────────────────────────

    describe('validateOwnerSeller', function() {

        function buildReq(user, relatedParty) {
            return {
                user: user,
                prevBody: { relatedParty: relatedParty }
            };
        }

        it('should allow when user is owner and has seller role', function(done) {
            const req = buildReq(seller, ownerRelatedParty);

            resourceUtils.validateOwnerSeller(req, function(err) {
                expect(err).toBe(null);
                done();
            });
        });

        it('should return 403 when user is not the owner', function(done) {
            const req = buildReq(seller, otherRelatedParty);

            resourceUtils.validateOwnerSeller(req, function(err) {
                expect(err.status).toBe(403);
                expect(err.message).toBe('Unauthorized to update non-owned/non-seller resource specs');
                done();
            });
        });

        it('should return 403 when user does not have seller role', function(done) {
            const nonSeller = { id: 'test', roles: [{ name: 'Buyer' }], partyId: 'test' };
            const req = buildReq(nonSeller, ownerRelatedParty);

            resourceUtils.validateOwnerSeller(req, function(err) {
                expect(err.status).toBe(403);
                done();
            });
        });
    });

    // ─── validateNameAndDescription ───────────────────────────────────────────

    describe('validateNameAndDescription', function() {

        function buildReq(method, body) {
            return { method: method, parsedBody: body };
        }

        it('should pass for a valid name on POST', function(done) {
            resourceUtils.validateNameAndDescription(buildReq('POST', { name: 'Valid Name' }), function(err) {
                expect(err).toBe(null);
                done();
            });
        });

        it('should return 422 if name is missing on POST', function(done) {
            resourceUtils.validateNameAndDescription(buildReq('POST', {}), function(err) {
                expect(err.status).toBe(422);
                expect(err.message).toBe('Resource spec name is mandatory');
                done();
            });
        });

        it('should allow missing name on PATCH', function(done) {
            resourceUtils.validateNameAndDescription(buildReq('PATCH', { lifecycleStatus: 'Launched' }), function(err) {
                expect(err).toBe(null);
                done();
            });
        });

        it('should return 422 if name is too long', function(done) {
            resourceUtils.validateNameAndDescription(buildReq('POST', { name: 'x'.repeat(101) }), function(err) {
                expect(err.status).toBe(422);
                expect(err.message).toContain('too long');
                done();
            });
        });

        it('should return 422 if name is empty', function(done) {
            resourceUtils.validateNameAndDescription(buildReq('POST', { name: '   ' }), function(err) {
                expect(err.status).toBe(422);
                expect(err.message).toContain('empty');
                done();
            });
        });

        it('should return 422 if name is not a string', function(done) {
            resourceUtils.validateNameAndDescription(buildReq('POST', { name: 123 }), function(err) {
                expect(err.status).toBe(422);
                expect(err.message).toContain('must be a string');
                done();
            });
        });

        it('should return 422 if description is too long', function(done) {
            resourceUtils.validateNameAndDescription(buildReq('POST', { name: 'Valid', description: 'x'.repeat(100001) }), function(err) {
                expect(err.status).toBe(422);
                expect(err.message).toContain('too long');
                done();
            });
        });

        it('should pass for a valid description', function(done) {
            resourceUtils.validateNameAndDescription(buildReq('POST', { name: 'Valid', description: 'A valid description' }), function(err) {
                expect(err).toBe(null);
                done();
            });
        });
    });

    // ─── getPrevVersion ───────────────────────────────────────────────────────

    describe('getPrevVersion', function() {

        const specPath = '/resourceSpecification/urn:spec:1';
        const apiUrl = `/${resourceEndpoint.path}${specPath}`;

        it('should attach prevBody to req on success', function(done) {
            const prevBody = { id: 'urn:spec:1', lifecycleStatus: 'Active' };
            nock(SERVER).get(`${API_PATH}${specPath}`).reply(200, prevBody);

            const req = { apiUrl: apiUrl };
            resourceUtils.getPrevVersion(resourceEndpoint)(req, function(err) {
                expect(err).toBe(null);
                expect(req.prevBody).toEqual(prevBody);
                done();
            });
        });

        it('should return 404 when the resource does not exist', function(done) {
            nock(SERVER).get(`${API_PATH}${specPath}`).reply(404, {});

            const req = { apiUrl: apiUrl };
            resourceUtils.getPrevVersion(resourceEndpoint)(req, function(err) {
                expect(err.status).toBe(404);
                expect(err.message).toBe('The required resource does not exist');
                done();
            });
        });

        it('should return 500 on unexpected errors', function(done) {
            nock(SERVER).get(`${API_PATH}${specPath}`).reply(500, {});

            const req = { apiUrl: apiUrl };
            resourceUtils.getPrevVersion(resourceEndpoint)(req, function(err) {
                expect(err.status).toBe(500);
                expect(err.message).toBe('The required resource cannot be created/updated');
                done();
            });
        });
    });

    // ─── canRetireSpec ────────────────────────────────────────────────────────

    describe('canRetireSpec', function() {

        it('should return false when all resources are retired or obsolete', function() {
            const data = [
                { lifecycleStatus: 'Retired' },
                { lifecycleStatus: 'Obsolete' }
            ];
            expect(resourceUtils.canRetireSpec(data)).toBe(false);
        });

        it('should return true when at least one resource is active', function() {
            const data = [
                { lifecycleStatus: 'Active' },
                { lifecycleStatus: 'Retired' }
            ];
            expect(resourceUtils.canRetireSpec(data)).toBe(true);
        });

        it('should return false for empty array', function() {
            expect(resourceUtils.canRetireSpec([])).toBe(false);
        });

        it('should return true for null or undefined (conservative: no data means cannot confirm retirement is safe)', function() {
            expect(resourceUtils.canRetireSpec(null)).toBe(true);
            expect(resourceUtils.canRetireSpec(undefined)).toBe(true);
        });
    });
});
