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
            env.FB_PIXEL_ID = '500';
            expect(await service.getNumber('FB_PIXEL_ID')).toBe(500);
        });

        it('returns NaN for non-numeric values', async () => {
            env.FB_PIXEL_ID = 'abc';
            expect(Number.isNaN(await service.getNumber('FB_PIXEL_ID'))).toBe(true);
        });
    });

    describe('setMany', () => {
        it('writes a string value', async () => {
            await service.setMany({ FB_PIXEL_ID: 'abc' });
            expect(store.get('FB_PIXEL_ID')).toBe('abc');
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
            expect(byKey.WELCOME_BOT_USERNAME).toMatchObject({ source: 'unset', value: '' });
        });

        it('exposes schema flags', async () => {
            const list = await service.listForAdmin();
            const username = list.find(s => s.key === 'WELCOME_BOT_USERNAME');
            expect(username).toMatchObject({
                required: true,
                group: 'telegram',
                type: 'string',
            });
        });

        it('returns every schema key exactly once', async () => {
            const list = await service.listForAdmin();
            const keys = list.map(s => s.key);
            expect(new Set(keys).size).toBe(keys.length);
            expect(keys).toContain('WELCOME_BOT_USERNAME');
            expect(keys).toContain('LANDING_URL');
        });
    });
});
