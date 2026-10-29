import 'reflect-metadata';
import { start, type LegacyServer } from './start';

// start() reports why it failed; the delay lets the log lines reach the output before exiting
start({ env: process.env, loadLegacy: () => require('../server.js') as Promise<LegacyServer> }).catch(() => {
    setTimeout(() => process.exit(1), 200);
});
