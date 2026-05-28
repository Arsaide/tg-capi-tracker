import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectBot } from 'nestjs-telegraf';
import { Telegraf } from 'telegraf';
import Redis from 'ioredis';
import { REDIS } from '../redis/redis.module';
import { SettingsService } from '../settings/settings.service';

const POOL_KEY = 'invite:pool';

@Injectable()
export class InvitePoolService {
    private readonly logger = new Logger(InvitePoolService.name);
    private refilling = false;

    constructor(
        @Inject(REDIS) private readonly redis: Redis,
        @InjectBot() private readonly bot: Telegraf,
        private readonly settings: SettingsService,
    ) {}

    async take(): Promise<string | null> {
        const link = await this.redis.rpop(POOL_KEY);
        if (link) return link;

        this.logger.warn('Pool empty, creating invite link inline');
        void this.refill();
        return this.createOne();
    }

    private async createOne(): Promise<string | null> {
        try {
            const channelId = await this.settings.getRequired('CHANNEL_ID');
            const res = await this.bot.telegram.createChatInviteLink(channelId, {
                member_limit: 1,
            });
            return res.invite_link;
        } catch (e: any) {
            this.logger.error(`createChatInviteLink failed: ${e?.message}`);
            return null;
        }
    }

    @Cron(CronExpression.EVERY_30_SECONDS)
    async refill(): Promise<void> {
        if (this.refilling) return;
        this.refilling = true;
        try {
            const min = (await this.settings.getNumber('POOL_MIN_SIZE')) || 200;
            const batch = (await this.settings.getNumber('POOL_REFILL_BATCH')) || 50;
            const delay = (await this.settings.getNumber('POOL_REFILL_DELAY_MS')) || 120;

            const current = await this.redis.llen(POOL_KEY);
            if (current >= min) return;

            const need = Math.min(batch, min - current);
            this.logger.log(`Refilling pool: have ${current}, creating ${need}`);

            for (let i = 0; i < need; i++) {
                const link = await this.createOne();
                if (link) await this.redis.lpush(POOL_KEY, link);
                await new Promise(r => setTimeout(r, delay));
            }
        } finally {
            this.refilling = false;
        }
    }
}
