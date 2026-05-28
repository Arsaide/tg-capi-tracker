import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { TrackingController } from './tracking.controller';
import { TrackingService } from './tracking.service';
import { InvitePoolService } from '../invite-pool/invite-pool.service';
import { CapiService } from '../capi/capi.service';

describe('TrackingController POST /track/click', () => {
    let app: INestApplication;
    let tracking: jest.Mocked<TrackingService>;
    let pool: jest.Mocked<InvitePoolService>;
    let capi: jest.Mocked<CapiService>;

    beforeEach(async () => {
        tracking = {
            createClick: jest.fn().mockResolvedValue('click-1'),
            bindLink: jest.fn().mockResolvedValue(undefined),
            getClick: jest.fn().mockResolvedValue({ ts: 1, fbclid: 'CL' }),
        } as unknown as jest.Mocked<TrackingService>;
        pool = {
            take: jest.fn().mockResolvedValue('https://t.me/+abc'),
        } as unknown as jest.Mocked<InvitePoolService>;
        capi = {
            send: jest.fn().mockResolvedValue(undefined),
        } as unknown as jest.Mocked<CapiService>;

        const moduleRef = await Test.createTestingModule({
            controllers: [TrackingController],
            providers: [
                { provide: TrackingService, useValue: tracking },
                { provide: InvitePoolService, useValue: pool },
                { provide: CapiService, useValue: capi },
            ],
        }).compile();

        app = moduleRef.createNestApplication();
        app.getHttpAdapter().getInstance().set('trust proxy', true);
        await app.init();
    });

    afterEach(async () => {
        await app.close();
    });

    it('captures the click context, binds the link, fires Lead, and returns the invite link', async () => {
        const res = await request(app.getHttpServer())
            .post('/track/click')
            .set('User-Agent', 'jest-ua')
            .send({ fbclid: 'CL', fbp: 'fb.1.1.2', fbc: 'fb.1.0.CL' });

        expect(res.status).toBe(201);
        expect(res.body).toEqual({ ok: true, inviteLink: 'https://t.me/+abc' });

        expect(tracking.createClick).toHaveBeenCalledWith(
            expect.objectContaining({
                fbclid: 'CL',
                fbp: 'fb.1.1.2',
                fbc: 'fb.1.0.CL',
                ua: 'jest-ua',
            }),
        );
        expect(pool.take).toHaveBeenCalled();
        expect(tracking.bindLink).toHaveBeenCalledWith('https://t.me/+abc', 'click-1');

        await new Promise(r => setImmediate(r));
        expect(capi.send).toHaveBeenCalledWith(
            expect.objectContaining({ eventName: 'Lead', eventId: 'lead_click-1' }),
        );
    });

    it('prefers the leftmost x-forwarded-for over the connection ip', async () => {
        await request(app.getHttpServer())
            .post('/track/click')
            .set('X-Forwarded-For', '5.5.5.5, 10.0.0.1')
            .send({ fbclid: 'X' });

        const ctx = tracking.createClick.mock.calls[0][0];
        expect(ctx.ip).toBe('5.5.5.5');
    });

    it('returns ok=false when the pool cannot provide a link', async () => {
        pool.take.mockResolvedValueOnce(null);
        const res = await request(app.getHttpServer()).post('/track/click').send({ fbclid: 'X' });
        expect(res.status).toBe(201);
        expect(res.body).toEqual({ ok: false, error: 'no_invite_link' });
        expect(tracking.bindLink).not.toHaveBeenCalled();
        expect(capi.send).not.toHaveBeenCalled();
    });

    it('does not block the response on CAPI failure', async () => {
        capi.send.mockRejectedValueOnce(new Error('boom'));
        const res = await request(app.getHttpServer()).post('/track/click').send({ fbclid: 'X' });
        expect(res.status).toBe(201);
        expect(res.body.ok).toBe(true);
    });
});
