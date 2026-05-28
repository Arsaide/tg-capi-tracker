import axios from 'axios';
import { createHash } from 'crypto';
import { CapiService, ClickContext } from './capi.service';
import { SettingsService } from '../settings/settings.service';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

function settingsStub(overrides: Partial<Record<string, string>> = {}): SettingsService {
    const defaults: Record<string, string> = {
        FB_PIXEL_ID: '123',
        FB_CAPI_TOKEN: 'tkn',
        FB_API_VERSION: 'v21.0',
        LANDING_URL: 'https://landing.example',
    };
    const values = { ...defaults, ...overrides };
    return {
        get: jest.fn(async (k: string) => values[k]),
        getRequired: jest.fn(async (k: string) => {
            if (!values[k]) throw new Error(`Setting ${k} is not configured`);
            return values[k];
        }),
    } as unknown as SettingsService;
}

function clickCtx(overrides: Partial<ClickContext> = {}): ClickContext {
    return { ts: 1_700_000_000_000, ...overrides };
}

describe('CapiService', () => {
    beforeEach(() => {
        mockedAxios.post.mockReset();
        mockedAxios.post.mockResolvedValue({ data: { events_received: 1 } });
    });

    describe('buildFbc', () => {
        it('formats as fb.1.<ts>.<fbclid>', () => {
            const service = new CapiService(settingsStub());
            expect(service.buildFbc('CLICK_ID', 1234567890)).toBe('fb.1.1234567890.CLICK_ID');
        });
    });

    describe('send – URL and version', () => {
        it('posts to the configured pixel/version with token in query', async () => {
            const service = new CapiService(
                settingsStub({ FB_API_VERSION: 'v19.0', FB_PIXEL_ID: '999' }),
            );
            await service.send({ eventName: 'Lead', ctx: clickCtx() });
            const url = mockedAxios.post.mock.calls[0][0];
            expect(url).toBe('https://graph.facebook.com/v19.0/999/events?access_token=tkn');
        });

        it('defaults API version to v21.0 when not configured', async () => {
            const service = new CapiService(settingsStub({ FB_API_VERSION: undefined }));
            await service.send({ eventName: 'Lead', ctx: clickCtx() });
            const url = mockedAxios.post.mock.calls[0][0];
            expect(url).toContain('/v21.0/');
        });

        it('throws when required setting is missing', async () => {
            const service = new CapiService(settingsStub({ FB_PIXEL_ID: undefined }));
            await expect(service.send({ eventName: 'Lead', ctx: clickCtx() })).rejects.toThrow(
                /FB_PIXEL_ID/,
            );
        });
    });

    describe('send – payload assembly', () => {
        it('uses ctx.fbc when present (preferred over fbclid)', async () => {
            const service = new CapiService(settingsStub());
            await service.send({
                eventName: 'Lead',
                ctx: clickCtx({ fbc: 'fb.1.111.READY', fbclid: 'RAW' }),
            });
            const body: any = mockedAxios.post.mock.calls[0][1];
            expect(body.data[0].user_data.fbc).toBe('fb.1.111.READY');
        });

        it('builds fbc from fbclid + ts when fbc cookie is missing', async () => {
            const service = new CapiService(settingsStub());
            await service.send({ eventName: 'Lead', ctx: clickCtx({ fbclid: 'XYZ', ts: 5555 }) });
            const body: any = mockedAxios.post.mock.calls[0][1];
            expect(body.data[0].user_data.fbc).toBe('fb.1.5555.XYZ');
        });

        it('omits fbc entirely when neither fbc nor fbclid is present', async () => {
            const service = new CapiService(settingsStub());
            await service.send({ eventName: 'Lead', ctx: clickCtx() });
            const body: any = mockedAxios.post.mock.calls[0][1];
            expect(body.data[0].user_data.fbc).toBeUndefined();
        });

        it('hashes tgUserId into external_id (SHA-256, lowercase + trim)', async () => {
            const service = new CapiService(settingsStub());
            await service.send({ eventName: 'Subscribe', ctx: clickCtx({ tgUserId: 12345 }) });
            const body: any = mockedAxios.post.mock.calls[0][1];
            const expected = createHash('sha256').update('12345').digest('hex');
            expect(body.data[0].user_data.external_id).toBe(expected);
        });

        it('passes fbp / IP / UA in user_data unhashed', async () => {
            const service = new CapiService(settingsStub());
            await service.send({
                eventName: 'Lead',
                ctx: clickCtx({ fbp: 'fb.1.1.2', ip: '1.2.3.4', ua: 'curl/8' }),
            });
            const ud: any = (mockedAxios.post.mock.calls[0][1] as any).data[0].user_data;
            expect(ud.fbp).toBe('fb.1.1.2');
            expect(ud.client_ip_address).toBe('1.2.3.4');
            expect(ud.client_user_agent).toBe('curl/8');
        });

        it('sets action_source=website and event_source_url=LANDING_URL', async () => {
            const service = new CapiService(settingsStub({ LANDING_URL: 'https://x.example' }));
            await service.send({ eventName: 'Lead', eventId: 'eid', ctx: clickCtx() });
            const ev = (mockedAxios.post.mock.calls[0][1] as any).data[0];
            expect(ev.action_source).toBe('website');
            expect(ev.event_source_url).toBe('https://x.example');
            expect(ev.event_id).toBe('eid');
            expect(ev.event_name).toBe('Lead');
            expect(ev.event_time).toEqual(expect.any(Number));
        });

        it('attaches custom_data only when value is provided', async () => {
            const service = new CapiService(settingsStub());
            await service.send({
                eventName: 'Purchase',
                value: 9.99,
                currency: 'EUR',
                ctx: clickCtx(),
            });
            const ev = (mockedAxios.post.mock.calls[0][1] as any).data[0];
            expect(ev.custom_data).toEqual({ value: 9.99, currency: 'EUR' });
        });

        it('defaults currency to USD when value but no currency', async () => {
            const service = new CapiService(settingsStub());
            await service.send({ eventName: 'Purchase', value: 1, ctx: clickCtx() });
            const ev = (mockedAxios.post.mock.calls[0][1] as any).data[0];
            expect(ev.custom_data).toEqual({ value: 1, currency: 'USD' });
        });

        it('omits custom_data when value is undefined', async () => {
            const service = new CapiService(settingsStub());
            await service.send({ eventName: 'Lead', ctx: clickCtx() });
            const ev = (mockedAxios.post.mock.calls[0][1] as any).data[0];
            expect(ev.custom_data).toBeUndefined();
        });

        it('attaches test_event_code only when FB_TEST_EVENT_CODE is configured', async () => {
            const off = new CapiService(settingsStub());
            await off.send({ eventName: 'Lead', ctx: clickCtx() });
            expect((mockedAxios.post.mock.calls[0][1] as any).test_event_code).toBeUndefined();

            mockedAxios.post.mockClear();
            const on = new CapiService(settingsStub({ FB_TEST_EVENT_CODE: 'TEST123' }));
            await on.send({ eventName: 'Lead', ctx: clickCtx() });
            expect((mockedAxios.post.mock.calls[0][1] as any).test_event_code).toBe('TEST123');
        });
    });

    describe('send – error handling', () => {
        it('re-throws axios errors', async () => {
            mockedAxios.post.mockRejectedValueOnce({
                response: { status: 400, data: { error: 'bad' } },
            });
            const service = new CapiService(settingsStub());
            await expect(
                service.send({ eventName: 'Lead', ctx: clickCtx() }),
            ).rejects.toBeDefined();
        });
    });
});
