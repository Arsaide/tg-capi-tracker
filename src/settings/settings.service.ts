import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';

export type SettingKey =
    | 'BOT_TOKEN'
    | 'CHANNEL_ID'
    | 'FB_PIXEL_ID'
    | 'FB_CAPI_TOKEN'
    | 'FB_API_VERSION'
    | 'FB_TEST_EVENT_CODE'
    | 'LANDING_URL'
    | 'POOL_MIN_SIZE'
    | 'POOL_REFILL_BATCH'
    | 'POOL_REFILL_DELAY_MS';

export interface SettingDef {
    key: SettingKey;
    type: 'string' | 'number';
    secret?: boolean;
    required?: boolean;
    default?: string | number;
    description?: string;
    restartRequired?: boolean;
    hiddenInUi?: boolean;
    group: 'telegram' | 'facebook' | 'pool';
}

export const SETTINGS: SettingDef[] = [
    {
        key: 'BOT_TOKEN',
        type: 'string',
        secret: true,
        required: true,
        restartRequired: true,
        hiddenInUi: true,
        group: 'telegram',
        description:
            'Telegram bot token. Бот должен быть админом канала с правом can_invite_users.',
    },
    {
        key: 'CHANNEL_ID',
        type: 'string',
        required: true,
        group: 'telegram',
        description: 'Numeric channel id, например -1001234567890.',
    },
    { key: 'FB_PIXEL_ID', type: 'string', required: true, group: 'facebook' },
    {
        key: 'FB_CAPI_TOKEN',
        type: 'string',
        secret: true,
        required: true,
        group: 'facebook',
        description: 'System User access token из Events Manager.',
    },
    { key: 'FB_API_VERSION', type: 'string', default: 'v21.0', group: 'facebook' },
    {
        key: 'FB_TEST_EVENT_CODE',
        type: 'string',
        group: 'facebook',
        description: 'Опц.: код из вкладки Test Events для отладки.',
    },
    {
        key: 'LANDING_URL',
        type: 'string',
        group: 'facebook',
        description: 'Идёт в event_source_url.',
    },
    {
        key: 'POOL_MIN_SIZE',
        type: 'number',
        default: 200,
        group: 'pool',
        description: 'Сколько ссылок держать наготове.',
    },
    {
        key: 'POOL_REFILL_BATCH',
        type: 'number',
        default: 50,
        group: 'pool',
        description: 'Сколько досоздавать за один проход.',
    },
    {
        key: 'POOL_REFILL_DELAY_MS',
        type: 'number',
        default: 120,
        group: 'pool',
        description: 'Пауза между createChatInviteLink (анти-ратлимит).',
    },
];

const SETTINGS_BY_KEY = Object.fromEntries(SETTINGS.map(s => [s.key, s])) as Record<
    SettingKey,
    SettingDef
>;

export type SettingSource = 'runtime' | 'env' | 'default' | 'unset';

export interface SettingView {
    key: SettingKey;
    type: 'string' | 'number';
    secret: boolean;
    required: boolean;
    restartRequired: boolean;
    description?: string;
    group: SettingDef['group'];
    default?: string | number;
    value: string;
    source: SettingSource;
}

@Injectable()
export class SettingsService {
    private readonly logger = new Logger(SettingsService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly config: ConfigService,
    ) {}

    async get(key: SettingKey): Promise<string | undefined> {
        const row = await this.prisma.setting.findUnique({ where: { key } });
        if (row && row.value !== '') return row.value;
        const fromEnv = this.config.get<string>(key);
        if (fromEnv != null && fromEnv !== '') return fromEnv;
        const def = SETTINGS_BY_KEY[key]?.default;
        return def != null ? String(def) : undefined;
    }

    async getRequired(key: SettingKey): Promise<string> {
        const v = await this.get(key);
        if (v == null || v === '') {
            throw new Error(`Setting ${key} is not configured (no runtime value, no env fallback)`);
        }
        return v;
    }

    async getNumber(key: SettingKey): Promise<number> {
        const v = await this.get(key);
        const n = v != null ? Number(v) : NaN;
        return Number.isFinite(n) ? n : NaN;
    }

    async setMany(values: Partial<Record<SettingKey, string | number | null>>): Promise<void> {
        const toSet: Array<{ key: SettingKey; value: string }> = [];
        const toDel: SettingKey[] = [];

        for (const [k, v] of Object.entries(values)) {
            if (!(k in SETTINGS_BY_KEY)) continue;
            const key = k as SettingKey;
            const def = SETTINGS_BY_KEY[key];
            if (def.hiddenInUi) continue;
            if (v == null || v === '') {
                toDel.push(key);
                continue;
            }
            if (def.type === 'number') {
                const n = Number(v);
                if (!Number.isFinite(n) || n < 0) {
                    throw new Error(`Setting ${k} must be a non-negative number, got ${v}`);
                }
                toSet.push({ key, value: String(n) });
            } else {
                toSet.push({ key, value: String(v) });
            }
        }

        await this.prisma.$transaction([
            ...toSet.map(({ key, value }) =>
                this.prisma.setting.upsert({
                    where: { key },
                    create: { key, value },
                    update: { value },
                }),
            ),
            ...(toDel.length
                ? [this.prisma.setting.deleteMany({ where: { key: { in: toDel } } })]
                : []),
        ]);

        this.logger.log(
            `Settings updated: set=${toSet.map(s => s.key).join(',') || '-'} del=${toDel.join(',') || '-'}`,
        );
    }

    async listForAdmin(): Promise<SettingView[]> {
        const rows = await this.prisma.setting.findMany();
        const stored = Object.fromEntries(rows.map(r => [r.key, r.value])) as Record<
            string,
            string
        >;

        return SETTINGS.filter(def => !def.hiddenInUi).map(def => {
            const dbVal = stored[def.key];
            const envVal = this.config.get<string>(def.key);

            let value = '';
            let source: SettingSource = 'unset';
            if (dbVal != null && dbVal !== '') {
                value = dbVal;
                source = 'runtime';
            } else if (envVal != null && envVal !== '') {
                value = envVal;
                source = 'env';
            } else if (def.default != null) {
                value = String(def.default);
                source = 'default';
            }

            return {
                key: def.key,
                type: def.type,
                secret: def.secret ?? false,
                required: def.required ?? false,
                restartRequired: def.restartRequired ?? false,
                description: def.description,
                group: def.group,
                default: def.default,
                value,
                source,
            };
        });
    }
}
