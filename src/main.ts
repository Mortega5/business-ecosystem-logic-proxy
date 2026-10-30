import 'reflect-metadata';
import { installGracefulShutdown } from './shutdown/graceful-shutdown';
import { start, type LegacyServer } from './start';

// start() reports why it failed; the delay lets the log lines reach the output before exiting
start({ env: process.env, loadLegacy: () => require('../server.js') as Promise<LegacyServer> })
    .then(({ app, legacy, logger, config }) => {
        installGracefulShutdown({ app, legacy, logger, timeoutMs: config.app.shutdownTimeoutMs });
    })
    .catch(() => {
        setTimeout(() => process.exit(1), 200);
    });
