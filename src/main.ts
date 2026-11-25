import 'reflect-metadata';
import { exitOnSignalUntilReady, installGracefulShutdown } from './shutdown/graceful-shutdown';
import { start } from './start';

const stopEarlyHandling = exitOnSignalUntilReady();

// start() reports why it failed; the delay lets the log lines reach the output before exiting
start({ env: process.env })
    .then(({ app, logger, config }) => {
        installGracefulShutdown({ app, logger, timeoutMs: config.app.shutdownTimeoutMs });
        stopEarlyHandling();
    })
    .catch(() => {
        setTimeout(() => process.exit(1), 200);
    });
