import { Controller, Get } from '@nestjs/common';
import { Public } from '../auth/public.decorator';
import { PACKAGE_VERSION as VERSION } from './package-version';

/** How long the process has been up, as `0 d, 1 h, 2 m, 3 s`. */
export const uptimeText = (seconds: number): string => {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds - days * 86400) / 3600);
    const minutes = Math.floor((seconds - days * 86400 - hours * 3600) / 60);
    const rest = Math.floor(seconds - days * 86400 - hours * 3600 - minutes * 60);
    return `${days} d, ${hours} h, ${minutes} m, ${rest} s`;
};

/** What is running: its version, the commit it was built from when the build says so (`BAE_GIT_HASH`), and how long it has been up. */
@Public()
@Controller('version')
export class VersionController {
    @Get()
    version(): { version: string; uptime: string; git_hash: string } {
        return { version: VERSION, uptime: uptimeText(process.uptime()), git_hash: process.env['BAE_GIT_HASH'] ?? '' };
    }
}
