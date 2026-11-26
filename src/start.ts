import type { Server } from 'node:http';
import type { NestExpressApplication } from '@nestjs/platform-express';
import pino from 'pino';
import { createApp } from './bootstrap';
import { loadAppConfig } from './config/config.loader';
import { envNameFor, type LegacyVariable } from './config/legacy-env';
import type { AppConfig } from './config/config.schema';
import { servePortal } from './portal/portal-static';
import { buildHttpsOptions } from './https/https-options';
import { configureSecurity } from './security/configure-security';
import { buildLoggerOptions } from './logging/pino-options';

const DEFAULT_HEADERS_TIMEOUT_MS = 60_000;
const HEADERS_MARGIN_MS = 5_000;

export interface RunningServer {
    app: NestExpressApplication;
    logger: pino.Logger;
    config: AppConfig;
}

export interface StartOptions {
    env: NodeJS.ProcessEnv;
    rootModule?: new () => object;
    logStream?: pino.DestinationStream;
}

/**
 * Starts the server. Everything before the Nest application exists is logged here, so a start-up
 * that is waiting for a dependency, or fails, is never silent.
 */
export const start = async (options: StartOptions): Promise<RunningServer> => {
    let config: AppConfig;
    const legacyVariables: LegacyVariable[] = [];
    try {
        config = loadAppConfig(options.env, (variable) => legacyVariables.push(variable));
    } catch (error) {
        // There is no logger without a valid configuration
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        throw error;
    }
    const logger = pino(buildLoggerOptions(config.logging), options.logStream).child({ context: 'Bootstrap' });

    try {
        for (const { variable, key } of legacyVariables) {
            logger.warn({ variable, key, replacement: envNameFor(key) }, 'Deprecated environment variable, still applied');
        }
        logger.info({ port: config.app.port, host: config.app.host, https: config.app.https.enabled }, 'Starting the server');

        const app = await createApp(options.rootModule, buildHttpsOptions(config.app.https));
        // The client address (req.ip) comes from X-Forwarded-For only for the proxies the configuration trusts
        // Behind a load balancer the server has to close an idle connection after the balancer does, or the balancer sends a request over
        // one that is being closed and answers 502. Node needs the time to read the headers to be longer than that wait
        const server = app.getHttpServer() as Server;
        server.keepAliveTimeout = config.http.keepAliveTimeoutMs;
        server.headersTimeout = Math.max(DEFAULT_HEADERS_TIMEOUT_MS, config.http.keepAliveTimeoutMs + HEADERS_MARGIN_MS);
        configureSecurity(app, config);
        servePortal(app);
        app.set('trust proxy', config.http.trustedProxies.length === 0 ? false : config.http.trustedProxies);
        await (config.app.host === undefined ? app.listen(config.app.port) : app.listen(config.app.port, config.app.host));
        logger.info({ port: config.app.port }, 'Server listening');

        return { app, logger, config };
    } catch (error) {
        logger.fatal({ err: error }, 'The server could not start');
        throw error;
    }
};
