import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { TrackingController } from './tracking.controller';
import { TrackingService } from './tracking.service';
import { CapiService } from '../capi/capi.service';
import { SettingsService } from '../settings/settings.service';
import { AdminGuard } from '../settings/admin.guard';

const ADMIN_TOKEN = 'secret-token';

describe('TrackingController', () => {
    let app: INestApplication;
    let tracking: jest.Mocked<TrackingService>;
    let capi: jest.Mocked<CapiService>;
    let settings: jest.Mocked<SettingsService>;

    beforeEach(async () => {
        tracking = {
            createClick: jest.fn().mockResolvedValue('click-1'),
            getClick: jest.fn().mockResolvedValue({ ts: 1, fbclid: 'CL' }),
            linkUser: jest.fn().mockResolvedValue(undefined),
        } as unknown as jest.Mocked<TrackingService>;
        capi = {
            send: jest.fn().mockResolvedValue(undefined),
        } as unknown as jest.Mocked<CapiService>;
        settings = {
            getRequired: jest.fn().mockResolvedValue('alex_welcome_bot'),
        } as unknown as jest.Mocked<SettingsService>;

        const moduleRef = await Test.createTestingModule({
            controllers: [TrackingController],
            providers: [
                { provide: TrackingService, useValue: tracking },
                { provide: CapiService, useValue: capi },
                { provide: SettingsService, useValue: settings },
                { provide: ConfigService, useValue: { get: () => ADMIN_TOKEN } },
                AdminGuard,
            ],
        }).compile();

        app = moduleRef.createNestApplication();
        app.getHttpAdapter().getInstance().set('trust proxy', true);
        await app.init();
    });

    afterEach(async () => {
        await app.close();
    });

    describe('POST /track/click', () => {
        it('captures the click and returns the welcome-bot deep link (no CAPI event)', async () => {
            const res = await request(app.getHttpServer())
                .post('/track/click')
                .set('User-Agent', 'jest-ua')
                .send({ fbclid: 'CL', fbp: 'fb.1.1.2', fbc: 'fb.1.0.CL' });

            expect(res.status).toBe(201);
            expect(res.body).toEqual({
                ok: true,
                url: 'https://t.me/alex_welcome_bot?start=click-1',
                inviteLink: 'https://t.me/alex_welcome_bot?start=click-1',
                clickId: 'click-1',
            });

            expect(tracking.createClick).toHaveBeenCalledWith(
                expect.objectContaining({
                    fbclid: 'CL',
                    fbp: 'fb.1.1.2',
                    fbc: 'fb.1.0.CL',
                    ua: 'jest-ua',
                }),
            );

            // The site-stage event is PageView (browser pixel) — the server fires nothing here.
            await new Promise(r => setImmediate(r));
            expect(capi.send).not.toHaveBeenCalled();
        });

        it('strips a leading @ from the configured username', async () => {
            settings.getRequired.mockResolvedValueOnce('@alex_welcome_bot');
            const res = await request(app.getHttpServer())
                .post('/track/click')
                .send({ fbclid: 'X' });
            expect(res.body.url).toBe('https://t.me/alex_welcome_bot?start=click-1');
        });

        it('prefers the leftmost x-forwarded-for over the connection ip', async () => {
            await request(app.getHttpServer())
                .post('/track/click')
                .set('X-Forwarded-For', '5.5.5.5, 10.0.0.1')
                .send({ fbclid: 'X' });

            const ctx = tracking.createClick.mock.calls[0][0];
            expect(ctx.ip).toBe('5.5.5.5');
        });
    });

    describe('POST /track/bot/activate', () => {
        it('rejects requests without the admin bearer token', async () => {
            const res = await request(app.getHttpServer())
                .post('/track/bot/activate')
                .send({ clickId: 'click-1', tgUserId: 555 });
            expect(res.status).toBe(401);
            expect(capi.send).not.toHaveBeenCalled();
        });

        it('fires Lead with the click attribution + external id', async () => {
            const res = await request(app.getHttpServer())
                .post('/track/bot/activate')
                .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
                .send({ clickId: 'click-1', tgUserId: 555 });

            expect(res.status).toBe(201);
            expect(res.body).toEqual({ ok: true });
            expect(tracking.linkUser).toHaveBeenCalledWith(555, 'click-1');
            expect(capi.send).toHaveBeenCalledWith(
                expect.objectContaining({
                    eventName: 'Lead',
                    eventId: 'lead_click-1',
                    ctx: expect.objectContaining({ fbclid: 'CL', tgUserId: 555 }),
                }),
            );
        });

        it('returns click_expired when the click is gone', async () => {
            tracking.getClick.mockResolvedValueOnce(null);
            const res = await request(app.getHttpServer())
                .post('/track/bot/activate')
                .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
                .send({ clickId: 'gone', tgUserId: 555 });

            expect(res.body).toEqual({ ok: false, error: 'click_expired' });
            expect(capi.send).not.toHaveBeenCalled();
        });
    });

    describe('POST /track/bot/start', () => {
        it('binds the tg user to the click (no CAPI event)', async () => {
            const res = await request(app.getHttpServer())
                .post('/track/bot/start')
                .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
                .send({ clickId: 'click-1', tgUserId: 777 });

            expect(res.body).toEqual({ ok: true });
            expect(tracking.linkUser).toHaveBeenCalledWith(777, 'click-1');
            expect(capi.send).not.toHaveBeenCalled();
        });
    });
});
