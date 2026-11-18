import type { NestExpressApplication } from '@nestjs/platform-express';
import type { AppConfig } from '../config/config.schema';

// What the legacy application allowed and exposed, so the portal keeps working
const CORS_METHODS = ['HEAD', 'POST', 'GET', 'PATCH', 'PUT', 'OPTIONS', 'DELETE'];
const CORS_HEADERS = [
    'origin',
    'content-type',
    'X-Auth-Token',
    'Tenant-ID',
    'Authorization',
    'X-Organization',
    'x-terms-accepted',
    'x-filtered-pagination-token'
];
const CORS_EXPOSED = ['X-Total-Count', 'x-filtered-pagination-token'];

/**
 * Security headers, CORS and CSRF protection, all from the configuration. It runs before the application starts to
 * listen, and the first of the three to be registered is the first to see a request: headers first, so that even a
 * refused request carries them.
 */
export const configureSecurity = (app: NestExpressApplication, config: Pick<AppConfig, 'http' | 'security'>): void => {
    const { http, security } = config;

    app.useSecurityHeaders({
        contentSecurityPolicy: { reportOnly: security.csp.reportOnly },
        crossOriginResourcePolicy: { policy: security.crossOriginResourcePolicy },
        strictTransportSecurity: security.hsts.enabled
            ? { maxAge: security.hsts.maxAgeSeconds, includeSubDomains: security.hsts.includeSubDomains }
            : false
    });

    if (security.csrf.enabled) {
        app.enableCsrfProtection({ trustedOrigins: security.csrf.trustedOrigins });
    }

    app.enableCors({
        origin: http.cors.origins.includes('*') ? '*' : http.cors.origins,
        methods: CORS_METHODS,
        allowedHeaders: CORS_HEADERS,
        exposedHeaders: http.cors.exposeRedirect ? [...CORS_EXPOSED, 'X-Redirect-URL'] : CORS_EXPOSED
    });
};
