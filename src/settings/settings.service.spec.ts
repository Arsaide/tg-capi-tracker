import { ConfigService } from '@nestjs/config';
import { makePrismaMock } from '../prisma/prisma.mock';
import type { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from './settings.service';

function makeConfig(env: Record<string, string>): ConfigService {
    return { get: (k: string) => env[k] } as unknown as ConfigService;
}

describe('SettingsService', () => {
    let prisma: PrismaService;
    let store: Map<string, string>;
    let env: Record<string, string>;
    let service: SettingsService;

    beforeEach(() => {
        ({ prisma, store } = makePrismaMock());
        env = {};
        service = new SettingsService(prisma, makeConfig(env));
    });

    describe('get cascade', () => {
        it('prefers db over env over default', async () => {
            store.set('FB_API_VERSION', 'v18.0');
            env.FB_API_VERSION = 'v19.0';
            expect(await service.get('FB_API_VERSION')).toBe('v18.0');
        });

        it('falls back to env when db is empty', async () => {
            env.FB_PIXEL_ID = 'env-pixel';
            expect(await service.get('FB_PIXEL_ID')).toBe('env-pixel');
        });

        it('falls back to schema default when neither set', async () => {
            expect(await service.get('FB_API_VERSION')).toBe('v21.0');
            expect(await service.get('POOL_MIN_SIZE')).toBe('200');
        });

        it('returns undefined when no value anywhere', async () => {
            expect(await service.get('FB_PIXEL_ID')).toBeUndefined();
        });

        it('treats empty-string db value as missing and falls back', async () => {
            store.set('FB_PIXEL_ID', '');
            env.FB_PIXEL_ID = 'env-pixel';
            expect(await service.get('FB_PIXEL_ID')).toBe('env-pixel');
        });
    });

    describe('getRequired', () => {
        it('throws when nothing configured', async () => {
            await expect(service.getRequired('FB_PIXEL_ID')).rejects.toThrow(/not configured/);
        });

        it('returns the resolved value otherwise', async () => {
            env.FB_PIXEL_ID = '777';
            await expect(service.getRequired('FB_PIXEL_ID')).resolves.toBe('777');
        });
    });

    describe('getNumber', () => {
        it('parses numeric strings', async () => {
            env.POOL_MIN_SIZE = '500';
            expect(await service.getNumber('POOL_MIN_SIZE')).toBe(500);
        });

        it('returns NaN for non-numeric values', async () => {
            env.POOL_MIN_SIZE = 'abc';
            expect(Number.isNaN(await service.getNumber('POOL_MIN_SIZE'))).toBe(true);
        });

        it('uses schema defaults', async () => {
            expect(await service.getNumber('POOL_REFILL_DELAY_MS')).toBe(120);
        });
    });

    describe('setMany', () => {
        it('writes a string value', async () => {
            await service.setMany({ FB_PIXEL_ID: 'abc' });
            expect(store.get('FB_PIXEL_ID')).toBe('abc');
        });

        it('coerces number type and stores as string', async () => {
            await service.setMany({ POOL_MIN_SIZE: 42 });
            expect(store.get('POOL_MIN_SIZE')).toBe('42');
        });

        it('accepts numeric strings for number fields', async () => {
            await service.setMany({ POOL_REFILL_BATCH: '17' });
            expect(store.get('POOL_REFILL_BATCH')).toBe('17');
        });

        it('rejects negative numbers', async () => {
            await expect(service.setMany({ POOL_MIN_SIZE: -1 })).rejects.toThrow(/non-negative/);
        });

        it('rejects non-numeric input for number fields', async () => {
            await expect(service.setMany({ POOL_MIN_SIZE: 'abc' })).rejects.toThrow(/non-negative/);
        });

        it('deletes runtime override on empty string', async () => {
            store.set('FB_PIXEL_ID', 'x');
            await service.setMany({ FB_PIXEL_ID: '' });
            expect(store.has('FB_PIXEL_ID')).toBe(false);
        });

        it('deletes runtime override on null', async () => {
            store.set('FB_PIXEL_ID', 'x');
            await service.setMany({ FB_PIXEL_ID: null });
            expect(store.has('FB_PIXEL_ID')).toBe(false);
        });

        it('silently ignores keys not in schema', async () => {
            await service.setMany({ HACK: 'x' } as any);
            expect(store.has('HACK')).toBe(false);
        });

        it('silently ignores writes to hiddenInUi keys (BOT_TOKEN)', async () => {
            await service.setMany({ BOT_TOKEN: 'attempted-overwrite' });
            expect(store.has('BOT_TOKEN')).toBe(false);
        });

        it('handles mixed set + delete in a single call', async () => {
            store.set('FB_PIXEL_ID', 'old');
            store.set('FB_API_VERSION', 'v18.0');
            await service.setMany({ FB_PIXEL_ID: 'new', FB_API_VERSION: '' });
            expect(store.get('FB_PIXEL_ID')).toBe('new');
            expect(store.has('FB_API_VERSION')).toBe(false);
        });

        it('wraps writes in a single $transaction', async () => {
            await service.setMany({ FB_PIXEL_ID: 'a', FB_API_VERSION: 'v20.0' });
            expect((prisma as any).$transaction).toHaveBeenCalledTimes(1);
        });
    });

    describe('listForAdmin', () => {
        it('marks source as runtime/env/default/unset', async () => {
            store.set('FB_PIXEL_ID', 'db-pixel');
            env.FB_CAPI_TOKEN = 'env-token';

            const list = await service.listForAdmin();
            const byKey = Object.fromEntries(list.map(s => [s.key, s]));

            expect(byKey.FB_PIXEL_ID).toMatchObject({ source: 'runtime', value: 'db-pixel' });
            expect(byKey.FB_CAPI_TOKEN).toMatchObject({ source: 'env', value: 'env-token' });
            expect(byKey.FB_API_VERSION).toMatchObject({ source: 'default', value: 'v21.0' });
            expect(byKey.CHANNEL_ID).toMatchObject({ source: 'unset', value: '' });
        });

        it('exposes schema flags', async () => {
            const list = await service.listForAdmin();
            const channel = list.find(s => s.key === 'CHANNEL_ID');
            expect(channel).toMatchObject({
                required: true,
                group: 'telegram',
                type: 'string',
            });
        });

        it('hides BOT_TOKEN (and any other hiddenInUi setting) from the list', async () => {
            store.set('BOT_TOKEN', 'some-token-in-db');
            const list = await service.listForAdmin();
            expect(list.find(s => s.key === 'BOT_TOKEN')).toBeUndefined();
        });

        it('still resolves BOT_TOKEN through get() / getRequired() (cascade unaffected)', async () => {
            env.BOT_TOKEN = 'env-bot';
            await expect(service.getRequired('BOT_TOKEN')).resolves.toBe('env-bot');
        });

        it('returns every visible schema key exactly once', async () => {
            const list = await service.listForAdmin();
            const keys = list.map(s => s.key);
            expect(new Set(keys).size).toBe(keys.length);
            expect(keys).toContain('POOL_REFILL_DELAY_MS');
            expect(keys).toContain('LANDING_URL');
            expect(keys).not.toContain('BOT_TOKEN');
        });
    });
});
