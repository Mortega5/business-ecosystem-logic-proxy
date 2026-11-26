import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The version is the one of the package, which is two folders up from here both in the sources and in the build
export const PACKAGE_VERSION = ((): string => {
    try {
        const { version } = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')) as { version?: unknown };
        return typeof version === 'string' ? version : 'unknown';
    } catch {
        return 'unknown';
    }
})();
