import { join } from 'node:path';
import { Global, Module, RequestMethod, type INestApplication } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ModulesContainer } from '@nestjs/core';
import SwaggerParser from '@apidevtools/swagger-parser';
import { Test, type TestingModule } from '@nestjs/testing';
import Ajv from 'ajv';
import { LoggerModule } from 'nestjs-pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { AuthModule } from '../auth/auth.module';
import { createApp } from '../bootstrap';
import { AppConfigService } from '../config/app-config.service';
import { AppModule } from '../app.module';
import { HealthModule } from '../health/health.module';
import { LegacyAuthBridge } from '../legacy/legacy-auth.bridge';
import { MongoConnectionService } from '../persistence/mongo-connection.service';
import { ContactUsModule } from '../contact-us/contact-us.module';
import { VersionModule } from '../version/version.module';
import { AccountModule } from '../tmf/account/account.module';
import { BillingModule } from '../tmf/billing/billing.module';
import { DocumentModule } from '../tmf/document/document.module';
import { ChargingModule } from '../tmf/charging/charging.module';
import { SoftwareModule } from '../tmf/software/software.module';
import { FakeFeaturesModule } from '../testing/fake-features';
import { cartItems, FakeCartModule } from '../testing/fake-cart';
import { FakeStatsModule } from '../testing/fake-stats';
import { PaymentModule } from '../payment/payment.module';
import { FakePortalModule } from '../testing/fake-portal';
import { CatalogModule } from '../tmf/catalog/catalog.module';
import { OrderingModule } from '../tmf/ordering/ordering.module';
import { UsageModule } from '../tmf/usage/usage.module';
import { ResourceModule } from '../tmf/resource/resource.module';
import { RevenueModule } from '../tmf/revenue/revenue.module';
import { InventoryModule } from '../tmf/inventory/inventory.module';
import { InvoicingModule } from '../tmf/invoicing/invoicing.module';
import { PartyModule } from '../tmf/party/party.module';
import { QuoteModule } from '../tmf/quote/quote.module';
import { ServiceModule } from '../tmf/service/service.module';
import { SearchModule } from '../tmf/search/search.module';
import { AS_ADMIN, AS_ORGANISATION, AS_SELLER, fakeLogin, LOGGED_IN } from '../testing/fake-login';
import { FakeUpstream } from '../testing/fake-upstream';

interface ResponseObject {
    headers?: Record<string, unknown>;
    content?: Record<string, { schema: object; example?: unknown; examples?: Record<string, { value: unknown }> }>;
}

interface Operation {
    parameters?: { name: string; in: string }[];
    responses: Record<string, ResponseObject>;
}

type Document = { paths: Record<string, Record<string, Operation>> };

const DOCUMENT_PATH = join(__dirname, '../../docs/openapi.yaml');

const tmforum = new FakeUpstream();

const mongo = { ping: vi.fn<(timeoutMs: number) => Promise<boolean>>() };

@Global()
@Module({
    providers: [
        {
            provide: AppConfigService,
            useValue: {
                app: { shutdownDelayMs: 0 },
                health: { mongoPingTimeoutMs: 500 },
                http: { bodyLimit: '1kb', uploadLimit: '1kb' },
                party: { editEnabled: true },
                search: { enabled: false },
                catalog: { partyLocation: 'https://schemas.example.org/party.json', defaultCatalogId: '', blueprintSchema: 'https://schemas.example.org/blueprint.json', systemCategories: [{ key: 'api', name: 'API', description: 'APIs' }] },
                quotes: { api: '/quote/quoteManagement' },
                dsp: {},
                portal: { chatUrl: '', knowledgeBaseUrl: '', ticketingUrl: '', matomoId: '', matomoUrl: '', googleTagManagerId: '', theme: '', extra: { siop: { enabled: false } } },
                limits: { orderItems: 50, cartItems: 100, noteLength: 10000, notesPerRequest: 20, nameLength: 100, descriptionLength: 100000, plansPerQuery: 20, providersPerQuery: 50, providerCacheMs: 300000, readAll: { pageSize: 100, maxPages: 100 } },
                stats: { ttlMs: 86400000, retryDelayMs: 600000, providerTtlMs: 60000 },
                purchase: { enabled: true, paymentProvider: 'dpas', get paymentGateway() { return `http://127.0.0.1:${tmforum.port}/`; } },
                auth: { propagateToken: true, allowLocalEori: false, roles: { admin: 'admin', customer: 'Buyer', seller: 'Seller', orgAdmin: 'orgAdmin' } },
                hasUpstream: () => false,
                upstream: (name: string) => ({ baseUrl: `http://127.0.0.1:${tmforum.port}/${name}`, timeoutMs: 300 })
            }
        },
        { provide: MongoConnectionService, useValue: mongo }
    ],
    exports: [AppConfigService, MongoConnectionService]
})
class DependenciesStub {}

const trimSlashes = (path: string): string => path.replace(/^\/+|\/+$/g, '');

const routesOf = (module: TestingModule): string[] => {
    const routes: string[] = [];
    for (const { controllers } of module.get(ModulesContainer, { strict: false }).values()) {
        for (const wrapper of controllers.values()) {
            const type = wrapper.metatype as (new () => object) | null;
            if (type === null) {
                continue;
            }
            const base = Reflect.getMetadata(PATH_METADATA, type) as string;
            for (const name of Object.getOwnPropertyNames(type.prototype)) {
                const handler = (type.prototype as Record<string, unknown>)[name];
                const method = typeof handler === 'function' ? (Reflect.getMetadata(METHOD_METADATA, handler) as number | undefined) : undefined;
                if (typeof handler === 'function' && method !== undefined) {
                    // An `all` route only closes a prefix with a 404: it is not part of the API
                    if (method === RequestMethod.ALL) {
                        continue;
                    }
                    for (const path of [Reflect.getMetadata(PATH_METADATA, handler) as string | string[]].flat()) {
                        const full = `/${[base, path].map(trimSlashes).filter(Boolean).join('/')}`;
                        routes.push(`${RequestMethod[method]?.toLowerCase()} ${full.replace(/:([A-Za-z]+)/g, '{$1}')}`);
                    }
                }
            }
        }
    }
    return routes.sort();
};

let document: Document;

beforeAll(async () => {
    document = (await SwaggerParser.validate(DOCUMENT_PATH)) as unknown as Document;
});

describe('docs/openapi.yaml', () => {
    it('is a valid OpenAPI document', () => {
        expect(Object.keys(document.paths).length).toBeGreaterThan(0);
    });

    it('has examples that match their schemas', () => {
        const ajv = new Ajv({ strict: false, allErrors: true });
        let checked = 0;
        for (const operations of Object.values(document.paths)) {
            for (const operation of Object.values(operations)) {
                for (const response of Object.values(operation.responses)) {
                    for (const media of Object.values(response.content ?? {})) {
                        const examples = [media.example, ...Object.values(media.examples ?? {}).map((e) => e.value)].filter(
                            (e) => e !== undefined
                        );
                        const validate = ajv.compile(media.schema);
                        for (const example of examples) {
                            expect(validate(example), JSON.stringify(validate.errors)).toBe(true);
                            checked++;
                        }
                    }
                }
            }
        }
        expect(checked).toBeGreaterThanOrEqual(4);
    });

    it('describes every route the Nest application implements, and only those', async () => {
        const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
        const documented = Object.entries(document.paths)
            .flatMap(([path, operations]) => Object.keys(operations).map((method) => `${method} ${path}`))
            .sort();

        expect(routesOf(module)).toEqual(documented);

        await module.close();
    });
});

describe('responses against docs/openapi.yaml', () => {
    let app: INestApplication;
    let url: string;
    const ajv = new Ajv({ strict: false, allErrors: true });

    interface Case {
        method: string;
        path: string;
        status: string;
        url?: string;
        headers?: Record<string, string>;
        body?: string;
        arrange: () => void;
    }

    interface ProxiedOptions {
        method?: string;
        headers?: Record<string, string>;
        body?: string;
        /** The request that is not valid: another url, or another body. */
        invalid?: { url?: string; body?: string };
        /** A body over the limit, when the route takes one: true for a JSON one, or the body itself. */
        tooLarge?: boolean | string;
        /** What the 200 is, when it is not JSON. */
        page?: { contentType: string; body: string };
    }

    // What every proxied route of the portal answers, as documented
    const proxied = (path: string, url: string, answer: string, options: ProxiedOptions = {}): Case[] => {
        const method = options.method ?? 'get';
        const headers = { ...LOGGED_IN, ...options.headers };
        const base = { method, path, url, ...(options.body === undefined ? {} : { body: options.body }) };
        return [
            {
                ...base,
                status: '200',
                headers,
                arrange: () =>
                    tmforum.answer((res) => {
                        if (options.page === undefined) {
                            tmforum.json(res, 200, answer);
                        } else {
                            res.writeHead(200, { 'content-type': options.page.contentType });
                            res.end(options.page.body);
                        }
                    })
            },
            ...(options.invalid === undefined
                ? []
                : [
                      {
                          ...base,
                          status: '400',
                          url: options.invalid.url ?? url,
                          ...(options.invalid.body === undefined ? {} : { body: options.invalid.body }),
                          headers,
                          arrange: () => undefined
                      }
                  ]),
            ...(options.tooLarge !== undefined && options.tooLarge !== false
                ? [
                      {
                          ...base,
                          status: '413',
                          body: typeof options.tooLarge === 'string' ? options.tooLarge : JSON.stringify({ filler: 'x'.repeat(2000) }),
                          headers,
                          arrange: () => undefined
                      }
                  ]
                : []),
            {
                ...base,
                status: '401',
                ...(options.headers === undefined
                    ? {}
                    : { headers: Object.fromEntries(Object.entries(options.headers).filter(([name]) => name.toLowerCase() !== 'authorization')) }),
                arrange: () => undefined
            },
            { ...base, status: '404', headers, arrange: () => tmforum.answer((res) => tmforum.json(res, 404, '{"error":"Not found"}')) },
            { ...base, status: '504', headers, arrange: () => tmforum.answer((res) => void setTimeout(() => res.end(), 800)) }
        ];
    };

    // A request the proxy refuses, or one that the upstream's answer makes it refuse
    const refused = (method: string, path: string, status: string, target: string, body: string | undefined, upstreamAnswer: string, caller: Record<string, string> = LOGGED_IN): Case => ({
        method,
        path,
        status,
        url: target,
        headers: { ...caller, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body }),
        arrange: () => tmforum.answer((res) => tmforum.json(res, 200, upstreamAnswer))
    });

    const quoteRoot = '/quote/quoteManagement';
    const quoteId = encodeURIComponent('urn:ngsi-ld:quote:7a1c0f3e');
    const json = { 'content-type': 'application/json' };
    const answer = '{"ok":true}';
    const UPLOAD_TYPE = 'multipart/form-data; boundary=b';
    const UPLOAD = '--b\r\nContent-Disposition: form-data; name="file"; filename="a.pdf"\r\n\r\nx\r\n--b--\r\n';

    // One entry per route of the quote service: its method, documented path, real path and what it takes
    const quoteRoutes: [string, string, string, ProxiedOptions][] = [
        ['post', 'createQuote', 'createQuote', { headers: json, body: '{"a":1}', invalid: { body: 'not json' }, tooLarge: true }],
        ['post', 'quote', 'quote', { headers: json, body: '{"a":1}', invalid: { body: 'not json' }, tooLarge: true }],
        ['get', 'quote', 'quote', {}],
        ['get', 'quoteById/{id}', `quoteById/${quoteId}`, { invalid: { url: `${quoteRoot}/quoteById/a%20b` } }],
        ['delete', 'quote/{id}', `quote/${quoteId}`, { invalid: { url: `${quoteRoot}/quote/a%20b` } }],
        ...['updateQuoteStatus', 'updateQuoteDate', 'addNoteToQuote'].map((name): [string, string, string, ProxiedOptions] => [
            'patch',
            `${name}/{id}`,
            `${name}/${quoteId}`,
            { headers: json, body: '{"a":1}', invalid: { url: `${quoteRoot}/${name}/a%20b` }, tooLarge: true }
        ]),
        ['get', 'quoteByUser/{userId}', 'quoteByUser/p-ana', { invalid: { url: `${quoteRoot}/quoteByUser/a%20b` } }],
        ['post', 'tendering/createCoordinatorQuote', 'tendering/createCoordinatorQuote', { headers: json, body: '{"a":1}', invalid: { body: 'not json' }, tooLarge: true }],
        ['post', 'tendering/createQuote', 'tendering/createQuote', { headers: json, body: '{"a":1}', invalid: { body: 'not json' }, tooLarge: true }],
        ['get', 'tendering/coordinatorQuotes/{userId}', 'tendering/coordinatorQuotes/p-ana', { invalid: { url: `${quoteRoot}/tendering/coordinatorQuotes/a%20b` } }],
        ['get', 'tendering/quotes/{userId}', 'tendering/quotes/p-ana', { invalid: { url: `${quoteRoot}/tendering/quotes/a%20b` } }],
        ['post', 'tendering/broadcastMessage', 'tendering/broadcastMessage', { headers: json, body: '{"a":1}', invalid: { body: 'not json' }, tooLarge: true }]
    ];

    const quoteCases = (): Case[] => [
        ...quoteRoutes.flatMap(([method, path, real, options]) =>
            proxied(`${quoteRoot}/${path}`, `${quoteRoot}/${real}`, answer, { ...options, method })
        ),
        ...proxied(`${quoteRoot}/addAttachmentToQuote/{id}`, `${quoteRoot}/addAttachmentToQuote/${quoteId}`, answer, {
            method: 'patch',
            headers: { 'content-type': UPLOAD_TYPE },
            body: UPLOAD,
            invalid: { url: `${quoteRoot}/addAttachmentToQuote/a%20b` },
            tooLarge: UPLOAD + 'x'.repeat(2000)
        }),
        ...['quoteByUser/{userId}', 'tendering/coordinatorQuotes/{userId}', 'tendering/quotes/{userId}'].map(
            (path): Case => ({
                method: 'get',
                path: `${quoteRoot}/${path}`,
                status: '403',
                url: `${quoteRoot}/${path.replace('{userId}', 'p-other')}`,
                headers: LOGGED_IN,
                arrange: () => undefined
            })
        ),
        {
            method: 'patch',
            path: `${quoteRoot}/addAttachmentToQuote/{id}`,
            status: '415',
            url: `${quoteRoot}/addAttachmentToQuote/${quoteId}`,
            headers: { ...LOGGED_IN, ...json },
            body: '{"a":1}',
            arrange: () => undefined
        }
    ];

    // The three inventories: a list of the caller and one resource, given when the caller is related to it
    const inventoryCases = (): Case[] =>
        ['inventory/product', 'serviceInventory/service', 'resourceInventory/resource'].flatMap((path) => [
            ...proxied(`/${path}`, `/${path}?limit=5&offset=0`, '[]', { invalid: { url: `/${path}?q=x` } }),
            ...proxied(`/${path}/{id}`, `/${path}/x-1`, '{"id":"x-1","relatedParty":[{"id":"p-ana","role":"Buyer"}]}', { invalid: { url: `/${path}/a%20b` } }),
            {
                method: 'get',
                path: `/${path}/{id}`,
                status: '403',
                url: `/${path}/x-1`,
                headers: LOGGED_IN,
                arrange: () => tmforum.answer((res) => tmforum.json(res, 200, '{"id":"x-1","relatedParty":[]}'))
            }
        ]);

    // The billing accounts: the list of the caller and one account, given to its owner; a write reads the account first
    const accountCases = (): Case[] => {
        const mine = '{"id":"x-1","relatedParty":[{"id":"p-ana","role":"Seller"}]}';
        const notMine = '{"id":"x-1","relatedParty":[{"id":"p-other","role":"Seller"}]}';
        const owner = '{"relatedParty":[{"id":"p-ana","role":"Seller"}]}';
        const badPhone = '{"contact":[{"contactMedium":[{"mediumType":"TelephoneNumber","characteristic":{"phoneNumber":"12"}}]}]}';
        return [
            ...proxied('/account/billingAccount', '/account/billingAccount?limit=5', '[]', { invalid: { url: '/account/billingAccount?q=x' } }),
            ...proxied('/account/billingAccount/{id}', '/account/billingAccount/x-1', mine, { invalid: { url: '/account/billingAccount/a%20b' } }),
            refused('get', '/account/billingAccount/{id}', '403', '/account/billingAccount/x-1', undefined, notMine),
            ...proxied('/account/billingAccount', '/account/billingAccount', '{"id":"x-1"}', {
                method: 'post',
                headers: json,
                body: owner,
                invalid: { body: 'not json' },
                tooLarge: true
            }),
            refused('post', '/account/billingAccount', '403', '/account/billingAccount', '{"relatedParty":[{"id":"p-other","role":"Seller"}]}', '{}'),
            refused('post', '/account/billingAccount', '422', '/account/billingAccount', `{"relatedParty":[{"id":"p-ana","role":"Seller"}],${badPhone.slice(1)}`, '{}'),
            ...proxied('/account/billingAccount/{id}', '/account/billingAccount/x-1', mine, {
                method: 'patch',
                headers: json,
                body: '{"state":"Active"}',
                invalid: { url: '/account/billingAccount/a%20b' },
                tooLarge: true
            }),
            refused('patch', '/account/billingAccount/{id}', '403', '/account/billingAccount/x-1', '{"state":"Active"}', notMine),
            refused('patch', '/account/billingAccount/{id}', '422', '/account/billingAccount/x-1', badPhone, mine)
        ];
    };

    // The bills: the list of the caller in a role, a bill and its name for a party of it, and the rates applied to it
    const billingCases = (): Case[] => {
        const mine = '{"id":"b-1","relatedParty":[{"id":"p-ana","role":"Buyer"}]}';
        const notMine = '{"id":"b-1","relatedParty":[{"id":"p-other","role":"Buyer"}]}';
        return [
            ...proxied('/billing/customerBill', '/billing/customerBill?limit=5&relatedParty.role=Seller', '[]', { invalid: { url: '/billing/customerBill?q=x' } }),
            refused('get', '/billing/customerBill', '403', '/billing/customerBill?relatedParty.role=Admin', undefined, '[]'),
            ...proxied('/billing/customerBill/{id}', '/billing/customerBill/b-1', mine, { invalid: { url: '/billing/customerBill/a%20b' } }),
            refused('get', '/billing/customerBill/{id}', '403', '/billing/customerBill/b-1', undefined, notMine),
            ...proxied('/billing/customerBill/{id}', '/billing/customerBill/b-1', mine, {
                method: 'patch',
                headers: json,
                body: '{"billNo":"March"}',
                invalid: { url: '/billing/customerBill/a%20b' },
                tooLarge: true
            }),
            refused('patch', '/billing/customerBill/{id}', '403', '/billing/customerBill/b-1', '{"billNo":"March"}', notMine),
            // The bill is read first and then its rates, so the upstream answers the bill to the first and the list to the second
            ...proxied('/billing/appliedCustomerBillingRate', '/billing/appliedCustomerBillingRate?bill.id=b-1', mine, { invalid: { url: '/billing/appliedCustomerBillingRate' } }).map((c) =>
                c.status === '200' ? { ...c, arrange: () => tmforum.answer((res) => tmforum.json(res, 200, res.req.url?.includes('/customerBill/') === true ? mine : '[]')) } : c
            ),
            refused('get', '/billing/appliedCustomerBillingRate', '403', '/billing/appliedCustomerBillingRate?bill.id=b-1', undefined, notMine)
        ];
    };

    // The contact form: open to anybody, and notified to the charging backend
    const contactUsCases = (): Case[] => {
        const form = JSON.stringify({ firstName: 'Ana', lastName: 'Lopez', email: 'ana@example.org', organization: 'Acme', roleInOrganization: 'CTO', message: 'Hello', privacyAccepted: true });
        const base = { method: 'post', path: '/contact-us', headers: json };
        return [
            { ...base, status: '200', body: form, arrange: () => tmforum.answer((res) => tmforum.json(res, 200, '{}')) },
            { ...base, status: '400', body: '{"firstName":"Ana"}', arrange: () => undefined },
            { ...base, status: '413', body: JSON.stringify({ filler: 'x'.repeat(2000) }), arrange: () => undefined },
            { ...base, status: '502', body: form, arrange: () => tmforum.answer((res) => tmforum.json(res, 500, '{}')) }
        ];
    };

    // The party API: the organisations are open, an individual is for those who are logged in, and a party is changed by itself
    const partyCases = (): Case[] => {
        const individual = '{"id":"p-bob","href":"p-bob","@type":"Individual","givenName":"Bob","familyName":"Builder"}';
        const withoutLogin = (cases: Case[]): Case[] => cases.filter((c) => c.status !== '401');
        return [
            ...withoutLogin(proxied('/party/organization', '/party/organization?fields=id&offset=0&limit=5', '[{"id":"p-acme"}]', { invalid: { url: '/party/organization?q=x' } })),
            refused('get', '/party/organization', '501', '/party/organization?lifecycleStatus=Launched&keyword=cloud', undefined, '[]', {}),
            refused('get', '/party/organization', '502', '/party/organization?lifecycleStatus=Launched&limit=6', undefined, 'not json', {}),
            ...withoutLogin(proxied('/party/organization/{id}', '/party/organization/p-acme', '{"id":"p-acme","tradingName":"Acme"}', { invalid: { url: '/party/organization/a%20b' } })),
            ...proxied('/party/individual/{id}', '/party/individual/p-bob', individual, { invalid: { url: '/party/individual/a%20b' } }),
            refused('get', '/party/individual/{id}', '502', '/party/individual/p-bob', undefined, 'not json'),
            ...proxied('/party/individual/{id}', '/party/individual/p-ana', '{"id":"p-ana"}', {
                method: 'patch',
                headers: json,
                body: '{"givenName":"Ana"}',
                invalid: { url: '/party/individual/a%20b' },
                tooLarge: true
            }),
            refused('patch', '/party/individual/{id}', '403', '/party/individual/p-bob', '{"givenName":"Bob"}', '{}'),
            ...proxied('/party/organization/{id}', '/party/organization/p-acme', '{"id":"p-acme"}', {
                method: 'patch',
                headers: { ...json, ...AS_ORGANISATION },
                body: '{"tradingName":"Acme"}',
                invalid: { url: '/party/organization/a%20b' },
                tooLarge: true
            }),
            refused('patch', '/party/organization/{id}', '403', '/party/organization/p-ana', '{"tradingName":"Ana"}', '{}'),
            refused('patch', '/party/organization/{id}', '422', '/party/organization/p-acme', '{"contactMedium":[{"mediumType":"TelephoneNumber"}]}', '{}', AS_ORGANISATION)
        ];
    };

    // The specifications of the resource and service catalogs: the list of the seller, one that is launched open to anybody, and the writes of a seller who owns it
    const specificationCases = (base: string, options: { dependents?: string; privateRead?: boolean; retire?: boolean } = {}): Case[] => {
        const { dependents = '/productSpecification', privateRead = false, retire = true } = options;
        const owned = '{"id":"r-1","lifecycleStatus":"Active","relatedParty":[{"id":"p-shop","role":"Seller"}]}';
        const launched = '{"id":"r-1","lifecycleStatus":"Launched","relatedParty":[{"id":"p-shop","role":"Seller"}]}';
        const notMine = '{"id":"r-1","lifecycleStatus":"Active","relatedParty":[{"id":"p-other","role":"Seller"}]}';
        const mine = { ...json, ...AS_SELLER };
        const withoutLogin = (cases: Case[]): Case[] => cases.filter((c) => c.status !== '401');
        return [
            ...proxied(base, `${base}?limit=6&offset=0`, '[]', { invalid: { url: `${base}?q=x` } }),
            ...(privateRead
                ? proxied(`${base}/{id}`, `${base}/r-1`, owned, { headers: AS_SELLER, invalid: { url: `${base}/a%20b` } })
                : withoutLogin(proxied(`${base}/{id}`, `${base}/r-1`, launched, { invalid: { url: `${base}/a%20b` } }))),
            refused('get', `${base}/{id}`, '403', `${base}/r-1`, undefined, owned),
            refused('get', `${base}/{id}`, '502', `${base}/r-1`, undefined, 'not json'),
            ...proxied(base, base, owned, { method: 'post', headers: mine, body: '{"name":"Dataset","relatedParty":[{"id":"p-shop","role":"Seller"}]}', invalid: { body: 'not json' }, tooLarge: true }),
            refused('post', base, '403', base, '{"name":"Dataset","relatedParty":[{"id":"p-other","role":"Seller"}]}', '{}', AS_SELLER),
            refused('post', base, '422', base, '{"relatedParty":[{"id":"p-shop","role":"Seller"}]}', '{}', AS_SELLER),
            ...proxied(`${base}/{id}`, `${base}/r-1`, owned, { method: 'patch', headers: mine, body: '{"name":"Changed"}', invalid: { url: `${base}/a%20b` }, tooLarge: true }),
            refused('patch', `${base}/{id}`, '403', `${base}/r-1`, '{"name":"Changed"}', notMine, AS_SELLER),
            refused('patch', `${base}/{id}`, '409', `${base}/r-1`, '{"relatedParty":[]}', owned, AS_SELLER),
            refused('patch', `${base}/{id}`, '422', `${base}/r-1`, '{"name":""}', owned, AS_SELLER),
            refused('patch', `${base}/{id}`, '502', `${base}/r-1`, '{"name":"Changed"}', 'not json', AS_SELLER),
            ...(retire
                ? [
                      ...proxied(`${base}/{id}`, `${base}/r-1`, owned, { method: 'delete', headers: AS_SELLER, invalid: { url: `${base}/a%20b` } }).filter((c) => c.status !== '200'),
                      {
                          method: 'delete',
                          path: `${base}/{id}`,
                          status: '200',
                          url: `${base}/r-1`,
                          headers: AS_SELLER,
                          arrange: () => tmforum.answer((res) => tmforum.json(res, 200, tmforum.seen?.url?.includes(dependents) === true ? '[]' : owned))
                      },
                      refused('delete', `${base}/{id}`, '403', `${base}/r-1`, undefined, notMine, AS_SELLER),
                      refused('delete', `${base}/{id}`, '409', `${base}/r-1`, undefined, '{"id":"r-1","lifecycleStatus":"Retired","relatedParty":[{"id":"p-shop","role":"Seller"}]}', AS_SELLER),
                      refused('delete', `${base}/{id}`, '502', `${base}/r-1`, undefined, 'not json', AS_SELLER)
                  ]
                : [])
        ];
    };

    // The usage specifications: the list of the seller, a create and a change; nothing else of /usage is served
    const usageCases = (): Case[] => {
        const base = '/usage/usageSpecification';
        const owned = '{"id":"u-1","lifecycleStatus":"Active","relatedParty":[{"id":"p-shop","role":"Seller"}]}';
        const notMine = '{"id":"u-1","lifecycleStatus":"Active","relatedParty":[{"id":"p-other","role":"Seller"}]}';
        const mine = { ...json, ...AS_SELLER };
        return [
            ...proxied(base, `${base}?limit=6&offset=0`, '[]', { invalid: { url: `${base}?q=x` } }),
            ...proxied(base, base, owned, { method: 'post', headers: mine, body: '{"name":"Calls","relatedParty":[{"id":"p-shop","role":"Seller"}]}', invalid: { body: 'not json' }, tooLarge: true }),
            refused('post', base, '403', base, '{"name":"Calls","relatedParty":[{"id":"p-other","role":"Seller"}]}', '{}', AS_SELLER),
            refused('post', base, '422', base, '{"relatedParty":[{"id":"p-shop","role":"Seller"}]}', '{}', AS_SELLER),
            ...proxied(`${base}/{id}`, `${base}/u-1`, owned, { method: 'patch', headers: mine, body: '{"name":"Changed"}', invalid: { url: `${base}/a%20b` }, tooLarge: true }),
            refused('patch', `${base}/{id}`, '403', `${base}/u-1`, '{"name":"Changed"}', notMine, AS_SELLER),
            refused('patch', `${base}/{id}`, '409', `${base}/u-1`, '{"relatedParty":[]}', owned, AS_SELLER),
            refused('patch', `${base}/{id}`, '422', `${base}/u-1`, '{"name":""}', owned, AS_SELLER),
            refused('patch', `${base}/{id}`, '502', `${base}/u-1`, '{"name":"Changed"}', 'not json', AS_SELLER)
        ];
    };

    // The product orders: the list and one order of the caller, a new order and a change; nothing else of /ordering is served
    const orderingCases = (): Case[] => {
        const base = '/ordering/productOrder';
        const party = (id: string, role: string) => `{"id":"${id}","role":"${role}"}`;
        const item = '{"id":"i-1","state":"acknowledged","product":{"relatedParty":[{"id":"p-shop","role":"Seller"}]}}';
        const mine = `{"id":"o-1","relatedParty":[${party('p-ana', 'Buyer')},${party('p-shop', 'Seller')}],"productOrderItem":[${item}],"note":[]}`;
        const notMine = `{"id":"o-1","relatedParty":[${party('p-other', 'Seller')}],"productOrderItem":[]}`;
        // One answer for every service the order is made with: the offering (for a buyer), the billing account, the order and the charging backend
        const everything = `{"id":"o-1","redirectUrl":"https://pay.example.org/1","relatedParty":[${party('p-shop', 'Seller')},${party('p-ana', 'Buyer')}]}`;
        const newOrder = `{"relatedParty":[${party('p-ana', 'Buyer')}],"billingAccount":{"id":"ba-1"},"productOrderItem":[{"id":"i-1","productOffering":{"id":"o-1"},"product":{}}]}`;
        const withLogin = { ...json, ...LOGGED_IN };
        const failCharging = (): void =>
            tmforum.answer((res) => tmforum.json(res, tmforum.seen?.url?.startsWith('/charging') === true ? 500 : 200, everything));
        const cancelFails = (): void =>
            tmforum.answer((res) => {
                const request = tmforum.seen;
                const order = '{"id":"o-1","relatedParty":[{"id":"p-ana","role":"Buyer"}],"productOrderItem":[{"id":"i-1","state":"acknowledged"}]}';
                tmforum.json(res, request?.method === 'PATCH' ? 500 : 200, order);
            });
        return [
            ...proxied(base, `${base}?limit=6&offset=0`, '[]', { invalid: { url: `${base}?q=x` } }),
            refused('get', base, '502', base, undefined, 'not json'),
            ...proxied(`${base}/{id}`, `${base}/o-1`, mine, { invalid: { url: `${base}/a%20b` } }),
            refused('get', `${base}/{id}`, '403', `${base}/o-1`, undefined, notMine),
            refused('get', `${base}/{id}`, '502', `${base}/o-1`, undefined, 'not json'),
            ...proxied(base, base, everything, { method: 'post', headers: withLogin, body: newOrder, invalid: { body: 'not json' }, tooLarge: true }).filter((c) => c.status !== '404'),
            refused('post', base, '403', base, `{"relatedParty":[${party('p-victim', 'Buyer')}],"productOrderItem":[]}`, everything),
            refused('post', base, '422', base, newOrder.replace('"billingAccount":{"id":"ba-1"},', ''), everything),
            { method: 'post', path: base, status: '502', url: base, headers: withLogin, body: newOrder, arrange: failCharging },
            ...proxied(`${base}/{id}`, `${base}/o-1`, mine, { method: 'patch', headers: withLogin, body: '{"note":[{"text":"Hi"}]}', invalid: { url: `${base}/a%20b` }, tooLarge: true }),
            refused('patch', `${base}/{id}`, '403', `${base}/o-1`, '{"billingAccount":{"id":"ba-2"}}', mine, LOGGED_IN),
            refused('patch', `${base}/{id}`, '422', `${base}/o-1`, '{"note":[{"text":""}]}', mine, LOGGED_IN),
            { method: 'patch', path: `${base}/{id}`, status: '502', url: `${base}/o-1`, headers: withLogin, body: '{"state":"cancelled"}', arrange: cancelFails }
        ];
    };

    // The categories of the catalog API: open to read and for an administrator to write; the rest of /catalog is the legacy application's
    const categoryCases = (): Case[] => {
        const base = '/catalog/category';
        const category = '{"id":"c-1","name":"Data","isRoot":true,"lifecycleStatus":"Launched"}';
        const asAdmin = { ...json, ...AS_ADMIN };
        const withoutLogin = (cases: Case[]): Case[] => cases.filter((c) => c.status !== '401');
        // A new category asks for the ones with its name (a list) and then is made (an object)
        const creates = (): void => tmforum.answer((res) => tmforum.json(res, 200, tmforum.seen?.method === 'GET' ? '[]' : category));
        return [
            ...withoutLogin(proxied(base, `${base}?limit=6&offset=0`, '[]', { invalid: { url: `${base}?q=x` } })),
            ...withoutLogin(proxied(`${base}/{id}`, `${base}/c-1`, category, { invalid: { url: `${base}/a%20b` } })),
            ...proxied(base, base, category, { method: 'post', headers: asAdmin, body: '{"name":"Data"}', invalid: { body: 'not json' }, tooLarge: true }).filter((c) => c.status !== '200' && c.status !== '404'),
            { method: 'post', path: base, status: '200', url: base, headers: asAdmin, body: '{"name":"Data"}', arrange: creates },
            refused('post', base, '403', base, '{"name":"Data"}', '[]', LOGGED_IN),
            refused('post', base, '409', base, '{"name":"Data"}', '[{"id":"c-2"}]', AS_ADMIN),
            refused('post', base, '502', base, '{"name":"Data"}', 'not json', AS_ADMIN),
            ...proxied(`${base}/{id}`, `${base}/c-1`, category, { method: 'patch', headers: asAdmin, body: '{"description":"x"}', invalid: { url: `${base}/a%20b` }, tooLarge: true }),
            refused('patch', `${base}/{id}`, '403', `${base}/c-1`, '{"description":"x"}', category, LOGGED_IN),
            refused('patch', `${base}/{id}`, '409', `${base}/c-1`, '{"relatedParty":[{"id":"p-1","role":"Seller"}]}', category, AS_ADMIN),
            refused('patch', `${base}/{id}`, '502', `${base}/c-1`, '{"description":"x"}', 'not json', AS_ADMIN)
        ];
    };

    // The charging backend: the confirmation of an order, the configuration of the e-mail of the administrator, and the upload of a file
    const chargingCases = (): Case[] => {
        const base = '/charging/api';
        const confirm = `${base}/orderManagement/orders/confirm`;
        const config = `${base}/orderManagement/notify/config`;
        const upload = `${base}/assetManagement/assets/uploadJob`;
        const administrator = { ...json, ...AS_ADMIN };
        const withoutLogin = (cases: Case[]): Case[] => cases.filter((c) => c.status !== '401');
        return [
            ...withoutLogin(proxied(confirm, `${confirm}/`, '{"ok":true}', { method: 'post', headers: json, body: '{"confirm_action":"accept"}', invalid: { body: 'not json' }, tooLarge: true })),
            ...proxied(config, config, '{"smtpServer":"smtp.example.org"}', { headers: AS_ADMIN }),
            refused('get', config, '403', config, undefined, '{}'),
            ...proxied(config, config, '{"ok":true}', { method: 'post', headers: administrator, body: '{"smtpServer":"smtp.example.org"}', invalid: { body: 'not json' }, tooLarge: true }),
            refused('post', config, '403', config, '{"smtpServer":"smtp.example.org"}', '{}'),
            ...proxied(upload, upload, '{"ok":true}', { method: 'post', headers: json, body: '{"content":{"name":"a.png","data":"QQ=="},"contentType":"image/png","isPublic":true}', invalid: { body: 'not json' }, tooLarge: true }),
            refused('post', upload, '422', upload, '{"content":{"name":"../a.png","data":"QQ=="},"contentType":"image/png"}', '{}')
        ];
    };

    // The catalogs and the offerings of the catalog API: what a seller makes, changes and retires, and what anybody reads
    const catalogAndOfferingCases = (): Case[] => {
        const catalogs = '/catalog/catalog';
        const offerings = '/catalog/productOffering';
        const seller = '{"id":"p-shop","role":"Seller"}';
        const other = '{"id":"p-other","role":"Seller"}';
        const mine = { ...json, ...AS_SELLER };
        const catalog = (extra = ''): string => `{"id":"cat-1","lifecycleStatus":"Active","relatedParty":[${seller}],"category":[{"id":"c-1"}]${extra}}`;
        const offering = (extra = ''): string => `{"id":"o-1","lifecycleStatus":"Active","productSpecification":{"id":"ps-1"},"relatedParty":[${seller}]${extra}}`;
        const product = `{"id":"ps-1","lifecycleStatus":"Launched","relatedParty":[${seller}]}`;
        const category = `{"id":"c-1","href":"c-1","name":"Mine","isRoot":true,"relatedParty":[${seller}]}`;
        // The catalog API with everything in its place, so that what is asked for is made
        const marketplace = (): void =>
            tmforum.answer((res) => {
                const method = tmforum.seen?.method;
                const path = (tmforum.seen?.url ?? '').replace(/^\/[^/]+/, '');
                const send = (status: number, body: string): void => tmforum.json(res, status, body);
                if (path.startsWith('/charging') || path.includes('offeringJob') || path.includes('validateJob')) {
                    send(200, '{}');
                } else if (path.startsWith('/individual') || path.startsWith('/organization')) {
                    send(200, '{"id":"p-ana"}');
                } else if (path.startsWith('/category')) {
                    send(method === 'POST' ? 201 : 200, category);
                } else if (path.startsWith('/productSpecification')) {
                    send(method === 'POST' ? 201 : 200, product);
                } else if (path.startsWith('/productOffering?')) {
                    send(200, '[]');
                } else if (path.startsWith('/productOffering/')) {
                    send(200, offering());
                } else if (path.startsWith('/productOffering')) {
                    send(201, offering());
                } else if (path.startsWith('/catalog?')) {
                    send(200, '[]');
                } else if (path.startsWith('/catalog/')) {
                    send(200, catalog());
                } else {
                    send(201, catalog());
                }
            });
        // What the proxied helper makes, without the 200 (which needs the whole catalog API) and without what the route does not answer
        const around = (path: string, url: string, options: ProxiedOptions, without: string[] = []): Case[] =>
            proxied(path, url, '{}', options).filter((c) => c.status !== '200' && !without.includes(c.status));
        const ok = (status: string, method: string, path: string, url: string, body?: string, headers: Record<string, string> = mine): Case => ({
            method,
            path,
            status,
            url,
            headers,
            ...(body === undefined ? {} : { body }),
            arrange: marketplace
        });
        const reads = (path: string, url: string, invalid: string): Case[] => around(path, url, { invalid: { url: invalid } }, ['401']);
        const newCatalog = '{"name":"Mine","relatedParty":[' + seller + ']}';
        const newOffering = '{"name":"Offer","productSpecification":{"id":"ps-1"}}';
        const catalogId = `${catalogs}/{id}`;
        const offeringId = `${offerings}/{id}`;
        const inCatalog = `${catalogs}/{catalogId}/productOffering`;
        const inCatalogUrl = `${catalogs}/cat-1/productOffering`;
        const writes = (path: string, url: string, body: string, bad: string, without: string[] = []): Case[] =>
            around(path, url, { method: path === catalogs || path === offerings || path === inCatalog ? 'post' : 'patch', headers: mine, body, invalid: { ...(bad === '' ? { body: 'not json' } : { url: bad }) }, tooLarge: true }, without);
        return [
            // Catalogs
            ok('201', 'post', catalogs, catalogs, newCatalog),
            ...writes(catalogs, catalogs, newCatalog, '', ['404']),
            refused('post', catalogs, '403', catalogs, newCatalog, '[]', LOGGED_IN),
            refused('post', catalogs, '409', catalogs, newCatalog, '[{"id":"cat-9"}]', AS_SELLER),
            refused('post', catalogs, '422', catalogs, '{"relatedParty":[' + seller + ']}', '[]', AS_SELLER),
            refused('post', catalogs, '502', catalogs, newCatalog, 'not json', AS_SELLER),
            refused('get', catalogId, '200', `${catalogs}/cat-1`, undefined, catalog().replace('Active', 'Launched'), {}),
            ...reads(catalogId, `${catalogs}/cat-1`, `${catalogs}/a%20b`),
            refused('get', catalogId, '403', `${catalogs}/cat-1`, undefined, catalog()),
            ok('200', 'patch', catalogId, `${catalogs}/cat-1`, '{"description":"x"}'),
            ...writes(catalogId, `${catalogs}/cat-1`, '{"description":"x"}', `${catalogs}/a%20b`),
            refused('patch', catalogId, '403', `${catalogs}/cat-1`, '{"description":"x"}', catalog().replace(seller, other), AS_SELLER),
            refused('patch', catalogId, '409', `${catalogs}/cat-1`, '{"relatedParty":[]}', catalog(), AS_SELLER),
            refused('patch', catalogId, '422', `${catalogs}/cat-1`, '{"name":""}', catalog(), AS_SELLER),
            refused('patch', catalogId, '502', `${catalogs}/cat-1`, '{"description":"x"}', 'not json', AS_SELLER),
            ok('200', 'delete', catalogId, `${catalogs}/cat-1`, undefined, AS_SELLER),
            ...around(catalogId, `${catalogs}/cat-1`, { method: 'delete', headers: AS_SELLER, invalid: { url: `${catalogs}/a%20b` } }),
            refused('delete', catalogId, '403', `${catalogs}/cat-1`, undefined, catalog().replace(seller, other), AS_SELLER),
            refused('delete', catalogId, '409', `${catalogs}/cat-1`, undefined, catalog().replace('Active', 'Retired'), AS_SELLER),
            refused('delete', catalogId, '502', `${catalogs}/cat-1`, undefined, 'not json', AS_SELLER),
            // The lists of offerings, of all of them and of a catalog
            ...proxied(offerings, `${offerings}?limit=6&offset=0&lifecycleStatus=Launched`, '[]', { invalid: { url: `${offerings}?q=x` } }).filter((c) => c.status !== '401'),
            refused('get', offerings, '501', `${offerings}?keyword=data`, undefined, '[]', {}),
            refused('get', offerings, '502', offerings, undefined, 'not json', {}),
            { method: 'get', path: inCatalog, status: '200', url: `${inCatalogUrl}?limit=6`, headers: {}, arrange: marketplace },
            ...proxied(inCatalog, `${inCatalogUrl}?limit=6`, '[]', { invalid: { url: `${inCatalogUrl}?q=x` } }).filter((c) => c.status === '400' || c.status === '504'),
            { method: 'get', path: inCatalog, status: '422', url: inCatalogUrl, headers: {}, arrange: () => tmforum.answer((res) => tmforum.json(res, 404, '{"error":"Not found"}')) },
            refused('get', inCatalog, '501', `${inCatalogUrl}?keyword=data`, undefined, '[]', {}),
            refused('get', inCatalog, '502', inCatalogUrl, undefined, 'not json', {}),
            // Offerings, made with or without a catalog in the route
            ok('201', 'post', offerings, offerings, newOffering),
            ...writes(offerings, offerings, newOffering, '', ['404']),
            refused('post', offerings, '403', offerings, newOffering, '{}', LOGGED_IN),
            refused('post', offerings, '422', offerings, '{"name":"Offer"}', '{}', AS_SELLER),
            refused('post', offerings, '502', offerings, newOffering, 'not json', AS_SELLER),
            ok('201', 'post', inCatalog, inCatalogUrl, newOffering),
            ...writes(inCatalog, inCatalogUrl, newOffering, '', []).filter((c) => c.status !== '404'),
            {
                method: 'post',
                path: inCatalog,
                status: '404',
                url: inCatalogUrl,
                headers: mine,
                body: newOffering,
                arrange: () => tmforum.answer((res) => tmforum.json(res, (tmforum.seen?.url ?? '').includes('/catalog/') ? 404 : 200, product))
            },
            refused('post', inCatalog, '403', inCatalogUrl, newOffering, '{}', LOGGED_IN),
            refused('post', inCatalog, '422', inCatalogUrl, '{"name":"Offer"}', '{}', AS_SELLER),
            refused('post', inCatalog, '502', inCatalogUrl, newOffering, 'not json', AS_SELLER),
            ok('200', 'get', offeringId, `${offerings}/o-1`, undefined, {}),
            ...reads(offeringId, `${offerings}/o-1`, `${offerings}/a%20b`),
            ok('200', 'patch', offeringId, `${offerings}/o-1`, '{"description":"x"}'),
            ...writes(offeringId, `${offerings}/o-1`, '{"description":"x"}', `${offerings}/a%20b`),
            refused('patch', offeringId, '403', `${offerings}/o-1`, '{"description":"x"}', offering().replace(seller, other), AS_SELLER),
            refused('patch', offeringId, '409', `${offerings}/o-1`, '{"relatedParty":[]}', offering(), AS_SELLER),
            refused('patch', offeringId, '422', `${offerings}/o-1`, '{"name":""}', offering(), AS_SELLER),
            refused('patch', offeringId, '502', `${offerings}/o-1`, '{"description":"x"}', 'not json', AS_SELLER),
            ok('200', 'delete', offeringId, `${offerings}/o-1`, undefined, AS_SELLER),
            ...around(offeringId, `${offerings}/o-1`, { method: 'delete', headers: AS_SELLER, invalid: { url: `${offerings}/a%20b` } }),
            refused('delete', offeringId, '403', `${offerings}/o-1`, undefined, offering().replace(seller, other), AS_SELLER),
            refused('delete', offeringId, '409', `${offerings}/o-1`, undefined, offering().replace('Active', 'Retired'), AS_SELLER),
            refused('delete', offeringId, '502', `${offerings}/o-1`, undefined, 'not json', AS_SELLER)
        ];
    };

    // The product specifications of the catalog API: the list and the read that anybody may do of what is public, and what a seller makes, changes and retires
    const productCases = (): Case[] => {
        const base = '/catalog/productSpecification';
        const id = `${base}/{id}`;
        const seller = '{"id":"p-shop","role":"Seller"}';
        const other = '{"id":"p-other","role":"Seller"}';
        const mine = { ...json, ...AS_SELLER };
        const owned = `{"id":"ps-1","lifecycleStatus":"Launched","relatedParty":[${seller}]}`;
        const draft = owned.replace('Launched', 'Active');
        const fresh = `{"name":"Data","relatedParty":[${seller}]}`;
        const withoutLogin = (cases: Case[]): Case[] => cases.filter((c) => c.status !== '401');
        // The catalog API and the charging backend with everything in its place, but for the charging backend that is down
        const marketplace = (chargingDown = false): void =>
            tmforum.answer((res) => {
                const path = (tmforum.seen?.url ?? '').replace(/^\/[^/]+/, '');
                if (path.includes('validateJob')) {
                    tmforum.json(res, chargingDown ? 500 : 200, '{}');
                } else if (path.startsWith('/productOffering?')) {
                    tmforum.json(res, 200, '[]');
                } else {
                    tmforum.json(res, tmforum.seen?.method === 'POST' ? 201 : 200, owned);
                }
            });
        const ok = (status: string, method: string, url: string, body?: string): Case => ({
            method,
            path: method === 'post' ? base : id,
            status,
            url,
            headers: mine,
            ...(body === undefined ? {} : { body }),
            arrange: marketplace
        });
        const around = (method: string, url: string, options: ProxiedOptions, without: string[] = []): Case[] =>
            proxied(method === 'post' ? base : id, url, '{}', { method, ...options }).filter((c) => c.status !== '200' && !without.includes(c.status));
        return [
            ...withoutLogin(proxied(base, `${base}?limit=6&offset=0`, '[]', { headers: AS_SELLER, invalid: { url: `${base}?q=x` } })),
            refused('get', base, '403', base, undefined, '[]', {}),
            ...withoutLogin(proxied(id, `${base}/ps-1`, owned, { invalid: { url: `${base}/a%20b` } })),
            refused('get', id, '403', `${base}/ps-1`, undefined, draft),
            refused('get', id, '502', `${base}/ps-1`, undefined, 'not json'),
            ok('201', 'post', base, fresh),
            ...around('post', base, { headers: mine, body: fresh, invalid: { body: 'not json' }, tooLarge: true }, ['404']),
            refused('post', base, '403', base, fresh, '{}', LOGGED_IN),
            refused('post', base, '422', base, `{"relatedParty":[${seller}]}`, '{}', AS_SELLER),
            {
                method: 'post',
                path: base,
                status: '502',
                url: base,
                headers: mine,
                body: fresh,
                arrange: () => marketplace(true)
            },
            ok('200', 'patch', `${base}/ps-1`, '{"description":"x"}'),
            ...around('patch', `${base}/ps-1`, { headers: mine, body: '{"description":"x"}', invalid: { url: `${base}/a%20b` }, tooLarge: true }),
            refused('patch', id, '403', `${base}/ps-1`, '{"description":"x"}', owned.replace(seller, other), AS_SELLER),
            refused('patch', id, '409', `${base}/ps-1`, '{"relatedParty":[]}', owned, AS_SELLER),
            refused('patch', id, '422', `${base}/ps-1`, '{"name":""}', owned, AS_SELLER),
            refused('patch', id, '502', `${base}/ps-1`, '{"description":"x"}', 'not json', AS_SELLER),
            ok('200', 'delete', `${base}/ps-1`),
            ...around('delete', `${base}/ps-1`, { headers: AS_SELLER, invalid: { url: `${base}/a%20b` } }),
            refused('delete', id, '403', `${base}/ps-1`, undefined, owned.replace(seller, other), AS_SELLER),
            refused('delete', id, '409', `${base}/ps-1`, undefined, owned.replace('Launched', 'Retired'), AS_SELLER),
            refused('delete', id, '502', `${base}/ps-1`, undefined, 'not json', AS_SELLER)
        ];
    };
    // The prices of the catalog API: what anybody reads, and what a seller makes and changes
    const priceCases = (): Case[] => {
        const base = '/catalog/productOfferingPrice';
        const id = `${base}/{id}`;
        const seller = '{"id":"p-shop","role":"Seller"}';
        const other = '{"id":"p-other","role":"Seller"}';
        const mine = { ...json, ...AS_SELLER };
        const owned = `{"id":"p-1","isBundle":false,"priceType":"recurring","relatedParty":[${seller}]}`;
        const fresh = '{"name":"Monthly","isBundle":false,"priceType":"recurring","price":{"value":"9.99","unit":"EUR"}}';
        const withoutLogin = (cases: Case[]): Case[] => cases.filter((c) => c.status !== '401');
        const marketplace = (): void =>
            tmforum.answer((res) => {
                const path = (tmforum.seen?.url ?? '').replace(/^\/[^/]+/, '');
                if (path.startsWith('/individual') || path.startsWith('/organization')) {
                    tmforum.json(res, 200, '{"id":"p-ana"}');
                } else if (path.startsWith('/productOfferingPrice?')) {
                    tmforum.json(res, 200, '[]');
                } else {
                    tmforum.json(res, tmforum.seen?.method === 'POST' ? 201 : 200, owned);
                }
            });
        const around = (method: string, url: string, options: ProxiedOptions, without: string[] = []): Case[] =>
            proxied(method === 'post' ? base : id, url, '{}', { method, ...options }).filter((c) => c.status !== '200' && !without.includes(c.status));
        return [
            ...withoutLogin(proxied(base, `${base}?limit=6&offset=0&id=p-1,p-2`, '[]', { invalid: { url: `${base}?q=x` } })),
            ...withoutLogin(proxied(id, `${base}/p-1`, owned, { invalid: { url: `${base}/a%20b` } })),
            { method: 'post', path: base, status: '201', url: base, headers: mine, body: fresh, arrange: marketplace },
            ...around('post', base, { headers: mine, body: fresh, invalid: { body: 'not json' }, tooLarge: true }, ['404']),
            refused('post', base, '403', base, fresh, '{}', LOGGED_IN),
            refused('post', base, '422', base, '{"name":"Monthly","price":{"value":"abc","unit":"EUR"}}', '{}', AS_SELLER),
            refused('post', base, '502', base, '{"name":"Monthly","relatedParty":[{"id":"urn:ngsi-ld:individual:ana","role":"Buyer"}]}', 'not json', AS_SELLER),
            { method: 'patch', path: id, status: '200', url: `${base}/p-1`, headers: mine, body: '{"description":"x"}', arrange: marketplace },
            ...around('patch', `${base}/p-1`, { headers: mine, body: '{"description":"x"}', invalid: { url: `${base}/a%20b` }, tooLarge: true }),
            refused('patch', id, '403', `${base}/p-1`, '{"description":"x"}', owned.replace(seller, other), AS_SELLER),
            refused('patch', id, '409', `${base}/p-1`, '{"relatedParty":[]}', owned, AS_SELLER),
            refused('patch', id, '422', `${base}/p-1`, '{"price":{"value":"x","unit":"EUR"}}', owned, AS_SELLER),
            refused('patch', id, '502', `${base}/p-1`, '{"description":"x"}', 'not json', AS_SELLER)
        ];
    };
    const paymentCases = (): Case[] => {
        const path = '/paymentInfo';
        return [
            {
                method: 'get',
                path,
                status: '200',
                headers: LOGGED_IN,
                arrange: () => tmforum.answer((res) => (tmforum.seen?.url?.includes('/count') === true ? void res.end('2') : tmforum.json(res, 200, '"token"')))
            },
            { method: 'get', path, status: '401', arrange: () => undefined },
            { method: 'get', path, status: '502', headers: LOGGED_IN, arrange: () => tmforum.answer((res) => tmforum.json(res, 500, '{}')) }
        ];
    };
    const cartCases = (): Case[] => {
        const items = '/shoppingCart/item';
        const own = { ...LOGGED_IN, ...json };
        return [
            { method: 'get', path: items, status: '200', headers: LOGGED_IN, arrange: () => undefined },
            { method: 'get', path: items, status: '401', arrange: () => undefined },
            { method: 'post', path: items, status: '201', headers: own, body: '{"id":"o-new","name":"Offer"}', arrange: () => undefined },
            { method: 'post', path: items, status: '400', headers: own, body: 'not json', arrange: () => undefined },
            { method: 'post', path: items, status: '401', headers: json, body: '{"id":"o-new"}', arrange: () => undefined },
            { method: 'post', path: items, status: '409', headers: own, body: '{"id":"o-kept"}', arrange: () => void cartItems.create({ user: 'u-ana', itemId: 'o-kept', itemObject: { id: 'o-kept' } }) },
            { method: 'post', path: items, status: '413', headers: own, body: JSON.stringify({ id: 'o-big', filler: 'x'.repeat(2000) }), arrange: () => undefined },
            { method: 'delete', path: `${items}/{id}`, status: '204', url: `${items}/o-del`, headers: LOGGED_IN, arrange: () => void cartItems.create({ user: 'u-ana', itemId: 'o-del', itemObject: { id: 'o-del' } }) },
            { method: 'delete', path: `${items}/{id}`, status: '400', url: `${items}/a%20b`, headers: LOGGED_IN, arrange: () => undefined },
            { method: 'delete', path: `${items}/{id}`, status: '401', url: `${items}/o-del`, arrange: () => undefined },
            { method: 'delete', path: `${items}/{id}`, status: '404', url: `${items}/o-none`, headers: LOGGED_IN, arrange: () => undefined },
            { method: 'post', path: '/shoppingCart/empty', status: '204', headers: LOGGED_IN, arrange: () => undefined },
            { method: 'post', path: '/shoppingCart/empty', status: '401', arrange: () => undefined }
        ];
    };
    const statsCases = (): Case[] => {
        const path = '/stats/provider/{organizationId}';
        const own = '/stats/provider/p-acme';
        return [
            { method: 'get', path: '/stats', status: '200', arrange: () => undefined },
            { method: 'get', path, status: '200', url: own, headers: AS_ORGANISATION, arrange: () => tmforum.answer((res) => tmforum.json(res, 200, '[{"lifecycleStatus":"Launched"}]')) },
            { method: 'get', path, status: '400', url: '/stats/provider/..%2Fx', headers: AS_ADMIN, arrange: () => undefined },
            { method: 'get', path, status: '401', url: own, arrange: () => undefined },
            { method: 'get', path, status: '403', url: '/stats/provider/p-other', headers: LOGGED_IN, arrange: () => undefined },
            { method: 'get', path, status: '502', url: '/stats/provider/p-broken', headers: AS_ADMIN, arrange: () => tmforum.answer((res) => tmforum.json(res, 500, '{}')) }
        ];
    };
    const cases: Case[] = [
        { method: 'get', path: '/version', status: '200', arrange: () => undefined },
        ...contactUsCases(),
        { method: 'get', path: '/config', status: '200', arrange: () => undefined },
        ...statsCases(),
        ...paymentCases(),
        ...cartCases(),
        { method: 'get', path: '/health/live', status: '200', arrange: () => mongo.ping.mockResolvedValue(false) },
        { method: 'get', path: '/health/ready', status: '200', arrange: () => mongo.ping.mockResolvedValue(true) },
        { method: 'get', path: '/health/ready', status: '503', arrange: () => mongo.ping.mockResolvedValue(false) },
        ...proxied(
            '/document/documentSpecification/{id}',
            `/document/documentSpecification/${encodeURIComponent('urn:ngsi-ld:document-specification:7a1c0f3e')}`,
            '{"id":"urn:ngsi-ld:document-specification:7a1c0f3e","name":"Terms"}',
            { invalid: { url: '/document/documentSpecification/a%20b' } }
        ),
        ...proxied(
            '/revenue/dashboard/{id}',
            `/revenue/dashboard/${encodeURIComponent('urn:ngsi-ld:organization:a195013a')}`,
            '[{"label":"Subscription","text":null,"link":null,"items":null}]',
            { invalid: { url: '/revenue/dashboard/a%20b' } }
        ),
        ...proxied('/search-bck/api/searchOrganizations', '/search-bck/api/searchOrganizations?page=0&size=100', '{"content":[]}', {
            method: 'post',
            headers: { 'content-type': 'application/json' },
            body: '{"categories":["Cloud"]}',
            invalid: { body: 'not json' },
            tooLarge: true
        }),
        ...['categories', 'countries', 'complianceLevels'].flatMap((name) =>
            proxied(`/search-bck/api/${name}`, `/search-bck/api/${name}`, '["Cloud","Data"]')
        ),
        ...proxied(
            '/invoicing/invoices/{id}',
            `/invoicing/invoices/${encodeURIComponent('urn:ngsi-ld:invoice:7a1c0f3e')}?format=xml-html`,
            '',
            {
                invalid: { url: '/invoicing/invoices/a%20b?format=xml-html' },
                page: { contentType: 'text/html', body: '<html><body><h1>Invoice</h1></body></html>' }
            }
        ),
        ...quoteCases(),
        ...inventoryCases(),
        ...accountCases(),
        ...billingCases(),
        ...partyCases(),
        ...specificationCases('/resource/resourceSpecification'),
        ...specificationCases('/service/serviceSpecification'),
        ...specificationCases('/software/resourceSpecification', { dependents: '/resource?' }),
        // A software specification also makes its support package, and says so when it cannot
        refused('post', '/software/resourceSpecification', '502', '/software/resourceSpecification', '{"@type":"SoftwareSpecification","name":"App","relatedParty":[{"id":"p-shop","role":"Seller"}]}', 'not json', AS_SELLER),
        ...specificationCases('/software/resource', { privateRead: true, retire: false }),
        ...usageCases(),
        ...orderingCases(),
        ...categoryCases(),
        ...catalogAndOfferingCases(),
        ...productCases(),
        ...priceCases(),
        ...chargingCases()
    ];

    beforeAll(async () => {
        await tmforum.start();

        @Module({ imports: [DependenciesStub, FakeFeaturesModule, LoggerModule.forRoot({ pinoHttp: { level: 'silent' } }), HealthModule, VersionModule, ContactUsModule, FakeStatsModule, FakeCartModule, PaymentModule, FakePortalModule, AuthModule, DocumentModule, RevenueModule, SearchModule, InvoicingModule, QuoteModule, InventoryModule, AccountModule, BillingModule, PartyModule, ResourceModule, ServiceModule, ChargingModule, SoftwareModule, UsageModule, OrderingModule, CatalogModule] })
        class Contract {}

        app = await createApp(express(), Contract);
        app.get(LegacyAuthBridge).attach([fakeLogin]);
        await app.listen(0);
        url = await app.getUrl();
    });

    afterAll(async () => {
        await app.close();
        await tmforum.stop();
    });

    beforeEach(() => {
        mongo.ping.mockReset();
        tmforum.reset();
    });

    it('has a case for every documented response', () => {
        const documented = Object.entries(document.paths)
            .flatMap(([path, operations]) =>
                Object.entries(operations).flatMap(([method, operation]) =>
                    Object.keys(operation.responses).map((status) => `${method} ${path} ${status}`)
                )
            )
            .sort();

        expect(cases.map((c) => `${c.method} ${c.path} ${c.status}`).sort()).toEqual(documented);
    });

    it.each(cases)('$method $path answers $status as documented', async ({ method, path, status, arrange, url: target, headers, body: requestBody }) => {
        arrange();
        const response = document.paths[path]?.[method]?.responses[status];

        const res = await fetch(`${url}${target ?? path}`, {
            method: method.toUpperCase(),
            ...(headers === undefined ? {} : { headers }),
            ...(requestBody === undefined ? {} : { body: requestBody })
        });

        expect(res.status).toBe(Number(status));
        const types = Object.keys(response?.content ?? {});
        if (types.length === 0) {
            // No content: the answer has no body
            expect(await res.text()).toBe('');
        } else if (types.includes('application/json')) {
            const schema = response?.content?.['application/json']?.schema;
            const validate = ajv.compile(schema ?? {});
            const body: unknown = await res.json();
            expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
        } else {
            // A page: the type is the documented one and there is a body
            expect(types.length).toBe(1);
            expect(res.headers.get('content-type')).toContain(types[0] ?? '');
            expect((await res.text()).length).toBeGreaterThan(0);
        }
        for (const header of Object.keys(response?.headers ?? {})) {
            expect(res.headers.get(header), `header ${header}`).not.toBeNull();
        }
    });

    it('returns the request id it is given', async () => {
        mongo.ping.mockResolvedValue(true);
        const declared = document.paths['/health/ready']?.get?.parameters?.find((p) => p.in === 'header');

        const res = await fetch(`${url}/health/ready`, { headers: { [declared?.name ?? '']: 'abc-123' } });

        expect(declared?.name).toBe('X-Request-Id');
        expect(res.headers.get('x-request-id')).toBe('abc-123');
    });
});
