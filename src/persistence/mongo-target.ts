import type { AppConfig } from '../config/config.schema';

type MongoSettings = AppConfig['mongo'];

/** Where the connection goes and with what credentials: the address has none in it, so it can be written to a log. */
export interface MongoTarget {
    uri: string;
    credentials?: { user: string; password: string };
    authSource?: string;
}

/**
 * The target of `mongo.*`: the URI as it is given, or else the one that `host`, `port` and `database` make (`localhost`, `27017` and
 * `belp` when they are not given). The user and the password never go in the URI, so they need no encoding and are never in the address
 * that is logged; the connection takes them as options.
 */
export const resolveMongoTarget = (mongo: Pick<MongoSettings, 'uri' | 'host' | 'port' | 'database' | 'user' | 'password' | 'authSource'>): MongoTarget => {
    if (mongo.uri !== undefined) {
        return { uri: mongo.uri };
    }
    return {
        uri: `mongodb://${mongo.host ?? 'localhost'}:${mongo.port ?? 27017}/${mongo.database ?? 'belp'}`,
        ...(mongo.user !== undefined && mongo.password !== undefined ? { credentials: { user: mongo.user, password: mongo.password } } : {}),
        ...(mongo.authSource === undefined ? {} : { authSource: mongo.authSource })
    };
};
