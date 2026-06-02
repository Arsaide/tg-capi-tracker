import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import Redis from 'ioredis';
import { REDIS } from '../redis/redis.module';
import { ClickContext } from '../capi/capi.service';

const TTL_SECONDS = 60 * 60 * 24 * 30;

@Injectable()
export class TrackingService {
    constructor(@Inject(REDIS) private readonly redis: Redis) {}

    private clickKey(id: string) {
        return `click:${id}`;
    }
    private userKey(uid: string | number) {
        return `tg:${uid}`;
    }

    async createClick(data: Omit<ClickContext, 'ts'> & { ts?: number }): Promise<string> {
        const clickId = randomUUID();
        const ctx: ClickContext = { ...data, ts: data.ts ?? Date.now() };
        await this.redis.set(this.clickKey(clickId), JSON.stringify(ctx), 'EX', TTL_SECONDS);
        return clickId;
    }

    async linkUser(uid: string | number, clickId: string): Promise<void> {
        await this.redis.set(this.userKey(uid), clickId, 'EX', TTL_SECONDS);
    }

    async getClickIdByUser(uid: string | number): Promise<string | null> {
        return this.redis.get(this.userKey(uid));
    }

    async getClick(clickId: string): Promise<ClickContext | null> {
        const raw = await this.redis.get(this.clickKey(clickId));
        return raw ? (JSON.parse(raw) as ClickContext) : null;
    }

    async getClickByUser(uid: string | number): Promise<ClickContext | null> {
        const clickId = await this.redis.get(this.userKey(uid));
        return clickId ? this.getClick(clickId) : null;
    }
}
