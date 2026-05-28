import IORedisMock from 'ioredis-mock';
import type Redis from 'ioredis';
import { Telegraf } from 'telegraf';
import { InvitePoolService } from './invite-pool.service';
import { SettingsService } from '../settings/settings.service';

function makeBot(impl?: () => Promise<{ invite_link: string }>): Telegraf {
    return {
        telegram: {
            createChatInviteLink: jest.fn(
                impl ??
                    (async () => ({
                        invite_link: 'https://t.me/+' + Math.random().toString(36).slice(2, 10),
                    })),
            ),
        },
    } as unknown as Telegraf;
}

function makeSettings(overrides: Record<string, number | string> = {}): SettingsService {
    const m: Record<string, any> = {
        CHANNEL_ID: '-1001234567890',
        POOL_MIN_SIZE: 3,
        POOL_REFILL_BATCH: 5,
        POOL_REFILL_DELAY_MS: 0,
        ...overrides,
    };
    return {
        getRequired: jest.fn(async (k: string) => String(m[k])),
        getNumber: jest.fn(async (k: string) => Number(m[k])),
    } as unknown as SettingsService;
}

let prefixCounter = 0;

describe('InvitePoolService', () => {
    let redis: Redis;

    beforeEach(() => {
        redis = new IORedisMock({ keyPrefix: `t${++prefixCounter}:` });
    });

    afterEach(async () => {
        redis.disconnect();
    });

    describe('take', () => {
        it('returns a link from the pool (RPOP) when non-empty', async () => {
            await redis.lpush('invite:pool', 'L1', 'L2', 'L3');
            const bot = makeBot();
            const svc = new InvitePoolService(redis, bot, makeSettings());

            const taken = await svc.take();
            expect(taken).toBe('L1');
            expect(await redis.llen('invite:pool')).toBe(2);
            expect(
                (bot.telegram.createChatInviteLink as jest.Mock).mock.calls.length,
            ).toBeGreaterThanOrEqual(0);
        });

        it('falls back to inline create when pool is empty', async () => {
            const bot = makeBot(async () => ({ invite_link: 'https://t.me/+inline' }));
            const svc = new InvitePoolService(redis, bot, makeSettings({ POOL_MIN_SIZE: 0 }));

            const taken = await svc.take();
            expect(taken).toBe('https://t.me/+inline');
            expect(bot.telegram.createChatInviteLink as jest.Mock).toHaveBeenCalledWith(
                '-1001234567890',
                { member_limit: 1 },
            );
        });

        it('returns null when inline create also fails', async () => {
            const bot = makeBot(async () => {
                throw new Error('rate limit');
            });
            const svc = new InvitePoolService(redis, bot, makeSettings({ POOL_MIN_SIZE: 0 }));
            const taken = await svc.take();
            expect(taken).toBeNull();
        });
    });

    describe('refill', () => {
        it('does nothing when pool is at or above min size', async () => {
            await redis.lpush('invite:pool', 'a', 'b', 'c');
            const bot = makeBot();
            const svc = new InvitePoolService(redis, bot, makeSettings({ POOL_MIN_SIZE: 3 }));
            await svc.refill();
            expect(bot.telegram.createChatInviteLink).not.toHaveBeenCalled();
        });

        it('creates only up to min-current, capped by batch', async () => {
            const bot = makeBot();
            const svc = new InvitePoolService(
                redis,
                bot,
                makeSettings({ POOL_MIN_SIZE: 10, POOL_REFILL_BATCH: 4 }),
            );
            await svc.refill();
            expect(bot.telegram.createChatInviteLink).toHaveBeenCalledTimes(4);
            expect(await redis.llen('invite:pool')).toBe(4);
        });

        it('creates min-current when min-current < batch', async () => {
            await redis.lpush('invite:pool', 'x');
            const bot = makeBot();
            const svc = new InvitePoolService(
                redis,
                bot,
                makeSettings({ POOL_MIN_SIZE: 3, POOL_REFILL_BATCH: 10 }),
            );
            await svc.refill();
            expect(bot.telegram.createChatInviteLink).toHaveBeenCalledTimes(2);
            expect(await redis.llen('invite:pool')).toBe(3);
        });

        it('skips lpush when createChatInviteLink fails for a slot', async () => {
            let n = 0;
            const bot = makeBot(async () => {
                n++;
                if (n === 2) throw new Error('boom');
                return { invite_link: `link-${n}` };
            });
            const svc = new InvitePoolService(
                redis,
                bot,
                makeSettings({ POOL_MIN_SIZE: 3, POOL_REFILL_BATCH: 3 }),
            );
            await svc.refill();
            expect(bot.telegram.createChatInviteLink).toHaveBeenCalledTimes(3);
            expect(await redis.llen('invite:pool')).toBe(2);
        });

        it('is reentrancy-safe: concurrent refill calls run only once', async () => {
            const bot = makeBot();
            const svc = new InvitePoolService(
                redis,
                bot,
                makeSettings({ POOL_MIN_SIZE: 3, POOL_REFILL_BATCH: 3 }),
            );
            await Promise.all([svc.refill(), svc.refill(), svc.refill()]);
            expect(bot.telegram.createChatInviteLink).toHaveBeenCalledTimes(3);
        });
    });
});
