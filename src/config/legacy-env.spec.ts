import { describe, expect, it } from 'vitest';
import { envNameFor, legacyEnvToObject } from './legacy-env';

describe('legacyEnvToObject', () => {
    it('maps the port of the legacy application', () => {
        expect(legacyEnvToObject({ BAE_LP_PORT: '9000' })).toEqual({
            values: { app: { port: '9000' } },
            used: [{ variable: 'BAE_LP_PORT', key: 'app.port' }]
        });
    });

    it('builds the MongoDB uri from its parts', () => {
        const { values, used } = legacyEnvToObject({
            BAE_LP_MONGO_SERVER: 'db.internal',
            BAE_LP_MONGO_PORT: '27018',
            BAE_LP_MONGO_DB: 'bae',
            BAE_LP_MONGO_USER: 'proxy',
            BAE_LP_MONGO_PASS: 'secret'
        });

        expect(values).toEqual({ mongo: { uri: 'mongodb://proxy:secret@db.internal:27018/bae' } });
        expect(used.map((u) => u.variable)).toEqual([
            'BAE_LP_MONGO_SERVER',
            'BAE_LP_MONGO_PORT',
            'BAE_LP_MONGO_DB',
            'BAE_LP_MONGO_USER',
            'BAE_LP_MONGO_PASS'
        ]);
    });

    it('fills the missing parts with the defaults of the legacy application', () => {
        expect(legacyEnvToObject({ BAE_LP_MONGO_SERVER: 'db.internal' }).values).toEqual({
            mongo: { uri: 'mongodb://db.internal:27017/belp' }
        });
        expect(legacyEnvToObject({ BAE_LP_MONGO_DB: 'other' }).values).toEqual({
            mongo: { uri: 'mongodb://mongo:27017/other' }
        });
    });

    it('uses credentials only when there is both a user and a password, as the legacy application does', () => {
        expect(legacyEnvToObject({ BAE_LP_MONGO_USER: 'proxy' }).values).toEqual({
            mongo: { uri: 'mongodb://mongo:27017/belp' }
        });
        expect(legacyEnvToObject({ BAE_LP_MONGO_PASS: 'secret' }).values).toEqual({
            mongo: { uri: 'mongodb://mongo:27017/belp' }
        });
    });

    it('escapes credentials that would break the uri', () => {
        const { values } = legacyEnvToObject({ BAE_LP_MONGO_USER: 'proxy', BAE_LP_MONGO_PASS: 'p@ss/w:rd' });

        expect(values).toEqual({ mongo: { uri: 'mongodb://proxy:p%40ss%2Fw%3Ard@mongo:27017/belp' } });
    });

    it('reports only the variables that are set and ignores empty ones', () => {
        expect(legacyEnvToObject({ BAE_LP_PORT: '', BAE_LP_MONGO_SERVER: '' })).toEqual({ values: {}, used: [] });
        expect(legacyEnvToObject({ PATH: '/bin', BAE_APP__PORT: '9000', BAE_LP_THEME: 'x' })).toEqual({ values: {}, used: [] });
    });
});

describe('envNameFor', () => {
    it.each([
        ['app.port', 'BAE_APP__PORT'],
        ['mongo.uri', 'BAE_MONGO__URI'],
        ['app.shutdownTimeoutMs', 'BAE_APP__SHUTDOWN_TIMEOUT_MS']
    ])('names the variable for %s', (key, expected) => {
        expect(envNameFor(key)).toBe(expected);
    });
});
