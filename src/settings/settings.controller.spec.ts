import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { makePrismaMock } from '../prisma/prisma.mock';
import { PrismaService } from '../prisma/prisma.service';
import { AdminGuard } from './admin.guard';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';

describe('SettingsController (e2e)', () => {
    let app: INestApplication;
    let store: Map<string, string>;
    const ADMIN_TOKEN = 'test-admin-token';

    beforeEach(async () => {
        const { prisma, store: s } = makePrismaMock();
        store = s;

        const moduleRef = await Test.createTestingModule({
            imports: [
                ConfigModule.forRoot({
                    isGlobal: true,
                    ignoreEnvFile: true,
                    load: [() => ({ ADMIN_TOKEN, FB_PIXEL_ID: 'env-pixel' })],
                }),
            ],
            controllers: [SettingsController],
            providers: [SettingsService, AdminGuard, { provide: PrismaService, useValue: prisma }],
        }).compile();

        app = moduleRef.createNestApplication();
        await app.init();
    });

    afterEach(async () => {
        await app.close();
    });

    describe('GET /admin', () => {
        it('serves the admin HTML without auth', async () => {
            const res = await request(app.getHttpServer()).get('/admin');
            expect(res.status).toBe(200);
            expect(res.headers['content-type']).toMatch(/html/);
            expect(res.text).toContain('tg-capi-tracker');
        });
    });

    describe('GET /admin/settings', () => {
        it('returns 401 without bearer token', async () => {
            const res = await request(app.getHttpServer()).get('/admin/settings');
            expect(res.status).toBe(401);
        });

        it('returns 401 with wrong bearer', async () => {
            const res = await request(app.getHttpServer())
                .get('/admin/settings')
                .set('Authorization', 'Bearer nope');
            expect(res.status).toBe(401);
        });

        it('returns settings list with sources', async () => {
            store.set('POOL_MIN_SIZE', '500');
            const res = await request(app.getHttpServer())
                .get('/admin/settings')
                .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
            expect(res.status).toBe(200);
            expect(Array.isArray(res.body.settings)).toBe(true);

            const byKey = Object.fromEntries(res.body.settings.map((s: any) => [s.key, s]));
            expect(byKey.POOL_MIN_SIZE).toMatchObject({ source: 'runtime', value: '500' });
            expect(byKey.FB_PIXEL_ID).toMatchObject({ source: 'env', value: 'env-pixel' });
            expect(byKey.FB_API_VERSION).toMatchObject({ source: 'default', value: 'v21.0' });
            expect(byKey.CHANNEL_ID).toMatchObject({ source: 'unset' });
            expect(byKey.BOT_TOKEN).toBeUndefined();
        });
    });

    describe('POST /admin/settings', () => {
        it('requires bearer token', async () => {
            const res = await request(app.getHttpServer())
                .post('/admin/settings')
                .send({ FB_PIXEL_ID: 'new' });
            expect(res.status).toBe(401);
        });

        it('writes accepted settings to the db', async () => {
            const res = await request(app.getHttpServer())
                .post('/admin/settings')
                .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
                .send({ FB_PIXEL_ID: 'new-pixel', POOL_MIN_SIZE: 300 });
            expect(res.status).toBe(201);
            expect(res.body).toEqual({ ok: true });
            expect(store.get('FB_PIXEL_ID')).toBe('new-pixel');
            expect(store.get('POOL_MIN_SIZE')).toBe('300');
        });

        it('rejects invalid number with 400', async () => {
            const res = await request(app.getHttpServer())
                .post('/admin/settings')
                .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
                .send({ POOL_MIN_SIZE: -5 });
            expect(res.status).toBe(400);
        });

        it('clears runtime override on empty string', async () => {
            store.set('FB_PIXEL_ID', 'temp');
            const res = await request(app.getHttpServer())
                .post('/admin/settings')
                .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
                .send({ FB_PIXEL_ID: '' });
            expect(res.status).toBe(201);
            expect(store.has('FB_PIXEL_ID')).toBe(false);
        });

        it('ignores unknown keys silently', async () => {
            const res = await request(app.getHttpServer())
                .post('/admin/settings')
                .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
                .send({ INJECT_ME: 'pwn', FB_PIXEL_ID: 'ok' });
            expect(res.status).toBe(201);
            expect(store.has('INJECT_ME')).toBe(false);
            expect(store.get('FB_PIXEL_ID')).toBe('ok');
        });
    });
});
