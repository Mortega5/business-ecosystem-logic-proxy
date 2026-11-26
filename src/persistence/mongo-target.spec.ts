import { describe, expect, it } from 'vitest';
import { resolveMongoTarget } from './mongo-target';

describe('resolveMongoTarget', () => {
    it('is the uri as it is given, credentials and options included', () => {
        expect(resolveMongoTarget({ uri: 'mongodb://ana:s3cret@db1,db2/bae?replicaSet=rs' })).toEqual({ uri: 'mongodb://ana:s3cret@db1,db2/bae?replicaSet=rs' });
    });

    it('is localhost, the port of Mongo and belp when nothing is given', () => {
        expect(resolveMongoTarget({})).toEqual({ uri: 'mongodb://localhost:27017/belp' });
    });

    it('is made of the parts that are given, and the others take the defaults', () => {
        expect(resolveMongoTarget({ host: 'db.internal', port: 27018, database: 'bae' })).toEqual({ uri: 'mongodb://db.internal:27018/bae' });
        expect(resolveMongoTarget({ database: 'bae' })).toEqual({ uri: 'mongodb://localhost:27017/bae' });
    });

    it('keeps the user and the password out of the address, as they are, and gives the database to authenticate against', () => {
        expect(resolveMongoTarget({ host: 'db', user: 'ana', password: 'p@ss/w:rd', authSource: 'admin' })).toEqual({
            uri: 'mongodb://db:27017/belp',
            credentials: { user: 'ana', password: 'p@ss/w:rd' },
            authSource: 'admin'
        });
    });
});
