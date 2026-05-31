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
