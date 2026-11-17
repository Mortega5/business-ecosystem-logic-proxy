import 'reflect-metadata';
import { exitOnSignalUntilReady, installGracefulShutdown } from './shutdown/graceful-shutdown';
import { start, type LegacyServer } from './start';

const stopEarlyHandling = exitOnSignalUntilReady();

// start() reports why it failed; the delay lets the log lines reach the output before exiting
start({ env: process.env, loadLegacy: () => require('../server.js') as Promise<LegacyServer> })
    .then(({ app, legacy, logger, config }) => {
        installGracefulShutdown({ app, legacy, logger, timeoutMs: config.app.shutdownTimeoutMs });
        stopEarlyHandling();
    })
    .catch(() => {
        setTimeout(() => process.exit(1), 200);
    });
