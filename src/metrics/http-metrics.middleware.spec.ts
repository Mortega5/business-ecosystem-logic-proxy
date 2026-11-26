import { Controller, ForbiddenException, Get, type INestApplication, Module, type NestModule, type MiddlewareConsumer, Param, UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { HttpMetricsMiddleware } from './http-metrics.middleware';
import { MetricsService } from './metrics.service';

@Controller('catalog')
class SampleController {
    @Get(':id')
    one(@Param('id') id: string): { id: string } {
        return { id };
    }

    @Get(':id/private')
    secret(): never {
        throw new UnauthorizedException();
    }

    @Get(':id/forbidden')
    forbidden(): never {
        throw new ForbiddenException();
    }
}

const observed = vi.fn<(method: string, route: string, status: number, seconds: number) => void>();
const authFailure = vi.fn<(status: number, api: string) => void>();

@Module({ controllers: [SampleController], providers: [HttpMetricsMiddleware, { provide: MetricsService, useValue: { observeHttpRequest: observed, authFailure } }] })
class SampleModule implements NestModule {
    configure(consumer: MiddlewareConsumer): void {
        consumer.apply(HttpMetricsMiddleware).forRoutes('*path');
    }
}

describe('HttpMetricsMiddleware', () => {
    let app: INestApplication;
    let url: string;

    beforeAll(async () => {
        app = (await Test.createTestingModule({ imports: [SampleModule] }).compile()).createNestApplication();
        await app.listen(0);
        url = await app.getUrl();
    });

    afterAll(async () => {
        await app.close();
    });

    const call = async (path: string): Promise<void> => {
        observed.mockClear();
        authFailure.mockClear();
        await (await fetch(`${url}${path}`)).text();
        await new Promise((resolve) => setTimeout(resolve, 20));
    };

    it('labels a request with the template of its route, not with its URL', async () => {
        await call('/catalog/abc-123');

        expect(observed).toHaveBeenCalledOnce();
        expect(observed.mock.calls[0]?.slice(0, 3)).toEqual(['GET', '/catalog/:id', 200]);
        expect(observed.mock.calls[0]?.[3]).toBeGreaterThanOrEqual(0);
    });

    it('gives one label to every path that no route answers', async () => {
        await call('/nothing/here/1');
        await call('/nothing/here/2');

        expect(observed.mock.calls[0]?.slice(0, 3)).toEqual(['GET', 'unmatched', 404]);
    });

    it('counts the requests that are refused by the API of their route, and no others', async () => {
        await call('/catalog/abc/private');
        await call('/catalog/abc/forbidden');
        expect(authFailure).toHaveBeenCalledWith(403, 'catalog');

        await call('/catalog/abc');
        expect(authFailure).not.toHaveBeenCalled();
    });

    it('tells a refusal by its status', async () => {
        await call('/catalog/abc/private');

        expect(authFailure).toHaveBeenCalledExactlyOnceWith(401, 'catalog');
    });
});
