import { Module } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuthModule } from '../auth/auth.module';
import { createApp } from '../bootstrap';
import { AppConfigModule } from '../config/app-config.module';
import { LoggingModule } from '../logging/logging.module';
import { useFakeLogin } from '../testing/fake-login';
import { FakeUpstream } from '../testing/fake-upstream';
import { ContactUsModule } from './contact-us.module';

const charging = new FakeUpstream();

@Module({ imports: [AppConfigModule, LoggingModule, AuthModule, ContactUsModule] })
class Root {}

const JSON_HEADERS = { 'content-type': 'application/json' };
const FORM = {
    supportType: 'Technical',
    firstName: 'Ana',
    lastName: 'Lopez',
    email: 'ana@example.org',
    organization: 'Acme',
    roleInOrganization: 'CTO',
    message: 'Line one\nLine two',
    privacyAccepted: true,
    marketingAccepted: false
};

let app: NestExpressApplication;
let url: string;
let status: number;

beforeAll(async () => {
    await charging.start();
    Object.assign(process.env, { BAE_UPSTREAMS__CHARGING__HOST: '127.0.0.1', BAE_UPSTREAMS__CHARGING__PORT: String(charging.port) });
    app = await createApp(Root);
    useFakeLogin(app);
    await app.listen(0);
    url = await app.getUrl();
});

afterAll(async () => {
    await app.close();
    await charging.stop();
});

beforeEach(() => {
    charging.reset();
    status = 200;
    charging.answer((res) => charging.json(res, status, '{"ok":true}'));
});

const send = (body: unknown) => fetch(`${url}/contact-us`, { method: 'POST', headers: JSON_HEADERS, body: typeof body === 'string' ? body : JSON.stringify(body) });
const notified = (): { subject: string; message: string; supportType?: string } => JSON.parse(charging.seen?.body ?? '{}') as { subject: string; message: string; supportType?: string };

describe('POST /contact-us', () => {
    it('is open, and notifies the charging backend of the form', async () => {
        const res = await send(FORM);

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ sent: true });
        expect(charging.seen?.method).toBe('POST');
        expect(charging.seen?.url).toBe('/charging/api/orderManagement/notify/configured');
        expect(notified().subject).toBe('New contact-us request');
        expect(notified().supportType).toBe('Technical');
        expect(notified().message).toBe(
            'First name: Ana<br>Last name: Lopez<br>Email: ana@example.org<br>Organization: Acme<br>Role in organization: CTO<br>Privacy accepted: Yes<br>Marketing accepted: No<br><br>Message:<br>Line one<br>Line two'
        );
    });

    it('does not pass on the identity or the headers of the visitor', async () => {
        await fetch(`${url}/contact-us`, { method: 'POST', headers: { ...JSON_HEADERS, authorization: 'Bearer secret', cookie: 'a=b' }, body: JSON.stringify(FORM) });

        expect(charging.seen?.headers['authorization']).toBeUndefined();
        expect(charging.seen?.headers['cookie']).toBeUndefined();
    });

    it('escapes what the visitor wrote', async () => {
        await send({ ...FORM, firstName: '<script>alert("x")</script>', message: '<b>hi</b> & \'bye\'' });

        expect(notified().message).toContain('First name: &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
        expect(notified().message).toContain('&lt;b&gt;hi&lt;/b&gt; &amp; &#39;bye&#39;');
        expect(notified().message).not.toContain('<script>');
    });

    it('does not need the support type', async () => {
        const { supportType: _ignored, ...withoutType } = FORM;
        expect((await send(withoutType)).status).toBe(200);
        expect(notified()).not.toHaveProperty('supportType');
    });

    it.each([
        ['an empty body', '{}'],
        ['something that is not JSON', 'not json'],
        ['a list', '[]'],
        ['a missing name', { ...FORM, firstName: undefined }],
        ['an empty message', { ...FORM, message: '   ' }],
        ['an email that is not one', { ...FORM, email: 'ana' }],
        ['a privacy policy that was not accepted', { ...FORM, privacyAccepted: false }],
        ['a privacy policy that is not a boolean', { ...FORM, privacyAccepted: 'true' }],
        ['a field that is not in the form', { ...FORM, to: 'victim@example.org' }],
        ['a name that is too long', { ...FORM, lastName: 'x'.repeat(101) }],
        ['a message that is too long', { ...FORM, message: 'x'.repeat(10001) }]
    ])('refuses %s, and notifies nobody', async (_name, body) => {
        const res = await send(body);

        expect(res.status).toBe(400);
        expect(charging.seen).toBeUndefined();
    });

    it.each([400, 500, 503])('tells the visitor when the notification is refused with %i, and not what the backend said', async (refused) => {
        status = refused;
        const res = await send(FORM);

        expect(res.status).toBe(502);
        expect(await res.json()).toEqual({ error: 'The message could not be sent' });
    });
});
