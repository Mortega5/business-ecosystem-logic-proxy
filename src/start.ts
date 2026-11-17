import type { NestExpressApplication } from '@nestjs/platform-express';
import pino from 'pino';
import { createApp } from './bootstrap';
import { loadAppConfig } from './config/config.loader';
import { envNameFor, type LegacyVariable } from './config/legacy-env';
import type { AppConfig } from './config/config.schema';
import { LegacyAuthBridge, type LegacyMiddleware } from './legacy/legacy-auth.bridge';
import type { LegacyHandler } from './legacy/legacy-fallback.filter';
import { buildHttpsOptions } from './https/https-options';
import { buildLoggerOptions } from './logging/pino-options';

export interface LegacyServer {
    app: LegacyHandler;
    authPipeline: LegacyMiddleware[];
    onlistening: () => void;
    stopBackgroundLoaders: () => void;
    close: () => Promise<void>;
}

export interface RunningServer {
    app: NestExpressApplication;
    legacy: LegacyServer;
    logger: pino.Logger;
    config: AppConfig;
}

export interface StartOptions {
    env: NodeJS.ProcessEnv;
    loadLegacy: () => Promise<LegacyServer>;
    rootModule?: new () => object;
    waitLogIntervalMs?: number;
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

        const started = Date.now();
        const waiting = setInterval(() => {
            logger.warn(
                { waitedSeconds: Math.round((Date.now() - started) / 1000) },
                'Still loading the legacy application, it waits for its dependencies such as MongoDB'
            );
        }, options.waitLogIntervalMs ?? 5000);
        const legacy = await options.loadLegacy().finally(() => clearInterval(waiting));
        logger.info('Legacy application loaded');

        const app = await createApp(legacy.app, options.rootModule, buildHttpsOptions(config.app.https));
        app.get(LegacyAuthBridge).attach(legacy.authPipeline);
        await (config.app.host === undefined ? app.listen(config.app.port) : app.listen(config.app.port, config.app.host));
        logger.info({ port: config.app.port }, 'Server listening');

        legacy.onlistening();
        return { app, legacy, logger, config };
    } catch (error) {
        logger.fatal({ err: error }, 'The server could not start');
        throw error;
    }
};
