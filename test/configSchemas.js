const CONFIG_PATH = require.resolve('../config');

describe('Config - JSON Schema locations', function() {

    const ENV_VARS = [
        'BAE_LP_DSP_CONTRACT_DEFINITION_SCHEMA',
        'BAE_LP_DEPLOYMENT_DEFINITION_SCHEMA',
        'BAE_LP_BLUEPRINT_SCHEMA',
        'BAE_LP_SCHEMA_ALLOWED_PREFIXES'
    ];
    const PAGES_BASE = 'https://tm-forum-model-66feba.pages.o-cei.eu/schemas/';

    let savedEnv;

    // config.js is evaluated once on require, so it is reloaded for every scenario
    const loadConfig = function() {
        delete require.cache[CONFIG_PATH];
        return require('../config');
    };

    beforeEach(function() {
        savedEnv = {};
        ENV_VARS.forEach((name) => {
            savedEnv[name] = process.env[name];
            delete process.env[name];
        });
    });

    afterEach(function() {
        ENV_VARS.forEach((name) => {
            if (savedEnv[name] === undefined) {
                delete process.env[name];
            } else {
                process.env[name] = savedEnv[name];
            }
        });
        delete require.cache[CONFIG_PATH];
    });

    it('should default to the versioned GitLab Pages schemas', function() {
        const config = loadConfig();

        expect(config.deploymentDefinitionSchema).toBe(PAGES_BASE + 'v2/deployment-definition.json');
        expect(config.blueprintSchema).toBe(PAGES_BASE + 'v1/blueprint-product-spec.json');
        expect(config.schemaBaseAllowList).toEqual([PAGES_BASE]);
    });

    it('should keep the DSP contract definition schema separate from the deployment definition one', function() {
        const config = loadConfig();

        expect(config.dspContractDefinitionSchema).toBe(
            'https://raw.githubusercontent.com/wistefan/edc-dsc/refs/heads/init/schemas/contract-definition.json'
        );
        expect(config.dspContractDefinitionSchema).not.toBe(config.deploymentDefinitionSchema);
    });

    it('should allow overriding every schema location through the environment', function() {
        process.env.BAE_LP_DSP_CONTRACT_DEFINITION_SCHEMA = 'https://example.com/contract.json';
        process.env.BAE_LP_DEPLOYMENT_DEFINITION_SCHEMA = 'https://example.com/deployment.json';
        process.env.BAE_LP_BLUEPRINT_SCHEMA = 'https://example.com/blueprint.json';

        const config = loadConfig();

        expect(config.dspContractDefinitionSchema).toBe('https://example.com/contract.json');
        expect(config.deploymentDefinitionSchema).toBe('https://example.com/deployment.json');
        expect(config.blueprintSchema).toBe('https://example.com/blueprint.json');
    });

    it('should read the schema allow list as a comma separated list', function() {
        process.env.BAE_LP_SCHEMA_ALLOWED_PREFIXES = ' https://a.example.com/schemas/ ,https://b.example.com/,, ';

        const config = loadConfig();

        expect(config.schemaBaseAllowList).toEqual([
            'https://a.example.com/schemas/',
            'https://b.example.com/'
        ]);
    });
});
