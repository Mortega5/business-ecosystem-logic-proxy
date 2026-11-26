import 'reflect-metadata';
import pino, { type Logger } from 'pino';
import { installCrashHandlers } from './shutdown/crash-handlers';
import { exitOnSignalUntilReady, installGracefulShutdown } from './shutdown/graceful-shutdown';
import { start } from './start';

const stopEarlyHandling = exitOnSignalUntilReady();

// Until the server has started its logger does not exist, and a plain one writes what failed
let crashLogger: Pick<Logger, 'fatal'> = pino();
installCrashHandlers(() => crashLogger);

// start() reports why it failed; the delay lets the log lines reach the output before exiting
start({ env: process.env })
    .then(({ app, logger, config }) => {
        crashLogger = logger;
        installGracefulShutdown({ app, logger, timeoutMs: config.app.shutdownTimeoutMs });
        stopEarlyHandling();
    })
    .catch(() => {
        setTimeout(() => process.exit(1), 200);
    });
