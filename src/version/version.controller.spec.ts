import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { uptimeText, VersionController } from './version.controller';

describe('GET /version', () => {
    it('says the version of the package, the commit of the build and how long it has been up', () => {
        const { version } = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')) as { version: string };
        process.env['BAE_GIT_HASH'] = 'abc123';

        const answer = new VersionController().version();

        expect(answer.version).toBe(version);
        expect(answer.git_hash).toBe('abc123');
        expect(answer.uptime).toMatch(/^\d+ d, \d+ h, \d+ m, \d+ s$/);
        delete process.env['BAE_GIT_HASH'];
        expect(new VersionController().version().git_hash).toBe('');
    });

    it('writes the uptime in days, hours, minutes and seconds', () => {
        expect(uptimeText(0)).toBe('0 d, 0 h, 0 m, 0 s');
        expect(uptimeText(90061)).toBe('1 d, 1 h, 1 m, 1 s');
    });
});
