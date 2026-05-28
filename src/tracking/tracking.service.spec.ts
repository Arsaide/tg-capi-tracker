import IORedisMock from 'ioredis-mock';
import type Redis from 'ioredis';
import { TrackingService } from './tracking.service';

const TTL = 60 * 60 * 24 * 30;

describe('TrackingService', () => {
    let redis: Redis;
    let service: TrackingService;

    beforeEach(() => {
        redis = new IORedisMock();
        service = new TrackingService(redis);
    });

    afterEach(async () => {
        await redis.flushall();
        redis.disconnect();
    });

    describe('createClick', () => {
        it('returns a uuid and stores the full context with TTL', async () => {
            const clickId = await service.createClick({
                fbclid: 'CL',
                fbp: 'fb.1.1.2',
                ip: '1.2.3.4',
                ua: 'Mozilla',
            });
            expect(clickId).toMatch(/^[0-9a-f-]{36}$/);

            const raw = await redis.get(`click:${clickId}`);
            const ctx = JSON.parse(raw);
            expect(ctx).toMatchObject({
                fbclid: 'CL',
                fbp: 'fb.1.1.2',
                ip: '1.2.3.4',
                ua: 'Mozilla',
            });
            expect(ctx.ts).toEqual(expect.any(Number));

            const ttl = await redis.ttl(`click:${clickId}`);
            expect(ttl).toBeGreaterThan(0);
            expect(ttl).toBeLessThanOrEqual(TTL);
        });

        it('honors caller-provided ts', async () => {
            const clickId = await service.createClick({ ts: 42, fbclid: 'X' });
            const ctx = JSON.parse(await redis.get(`click:${clickId}`));
            expect(ctx.ts).toBe(42);
        });
    });

    describe('bindLink / getByLink', () => {
        it('returns null for unknown invite link', async () => {
            expect(await service.getByLink('https://t.me/+missing')).toBeNull();
        });

        it('returns null when link maps to expired click', async () => {
            await service.bindLink('https://t.me/+x', 'orphan-click');
            expect(await service.getByLink('https://t.me/+x')).toBeNull();
        });

        it('round-trips clickId and ctx', async () => {
            const clickId = await service.createClick({ fbclid: 'CL', ip: '5.5.5.5' });
            await service.bindLink('https://t.me/+abc', clickId);

            const got = await service.getByLink('https://t.me/+abc');
            expect(got).not.toBeNull();
            expect(got.clickId).toBe(clickId);
            expect(got.ctx).toMatchObject({ fbclid: 'CL', ip: '5.5.5.5' });
        });

        it('sets TTL on the link mapping', async () => {
            await service.bindLink('https://t.me/+y', 'cid');
            const ttl = await redis.ttl('link:https://t.me/+y');
            expect(ttl).toBeGreaterThan(0);
            expect(ttl).toBeLessThanOrEqual(TTL);
        });
    });

    describe('linkUser / getClickByUser', () => {
        it('resolves the click stored against a tg user id', async () => {
            const clickId = await service.createClick({ fbclid: 'CL' });
            await service.linkUser(987, clickId);
            const ctx = await service.getClickByUser(987);
            expect(ctx).not.toBeNull();
            expect(ctx.fbclid).toBe('CL');
        });

        it('returns null when user has no mapping', async () => {
            expect(await service.getClickByUser(123)).toBeNull();
        });
    });
});
