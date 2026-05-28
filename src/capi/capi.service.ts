import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { createHash } from 'crypto';
import { SettingsService } from '../settings/settings.service';

export interface ClickContext {
    fbclid?: string;
    fbc?: string;
    fbp?: string;
    ip?: string;
    ua?: string;
    tgUserId?: number | string;
    ts: number;
}

export interface ConversionEvent {
    eventName: string;
    eventId?: string;
    value?: number;
    currency?: string;
    ctx: ClickContext;
}

@Injectable()
export class CapiService {
    private readonly logger = new Logger(CapiService.name);

    constructor(private readonly settings: SettingsService) {}

    private sha256(v: string): string {
        return createHash('sha256').update(v.trim().toLowerCase()).digest('hex');
    }

    buildFbc(fbclid: string, ts: number): string {
        return `fb.1.${ts}.${fbclid}`;
    }

    async send(ev: ConversionEvent): Promise<void> {
        const pixelId = await this.settings.getRequired('FB_PIXEL_ID');
        const token = await this.settings.getRequired('FB_CAPI_TOKEN');
        const version = (await this.settings.get('FB_API_VERSION')) || 'v21.0';
        const testCode = await this.settings.get('FB_TEST_EVENT_CODE');
        const landingUrl = await this.settings.get('LANDING_URL');

        const { ctx } = ev;
        const fbc = ctx.fbc || (ctx.fbclid ? this.buildFbc(ctx.fbclid, ctx.ts) : undefined);

        const userData: Record<string, unknown> = {};
        if (fbc) userData.fbc = fbc;
        if (ctx.fbp) userData.fbp = ctx.fbp;
        if (ctx.ip) userData.client_ip_address = ctx.ip;
        if (ctx.ua) userData.client_user_agent = ctx.ua;
        if (ctx.tgUserId != null) {
            userData.external_id = this.sha256(String(ctx.tgUserId));
        }

        const eventData: Record<string, unknown> = {
            event_name: ev.eventName,
            event_time: Math.floor(Date.now() / 1000),
            action_source: 'website',
            event_source_url: landingUrl,
            event_id: ev.eventId,
            user_data: userData,
        };
        if (ev.value != null) {
            eventData.custom_data = { value: ev.value, currency: ev.currency || 'USD' };
        }

        const payload: Record<string, unknown> = { data: [eventData] };
        if (testCode) payload.test_event_code = testCode;

        const url = `https://graph.facebook.com/${version}/${pixelId}/events?access_token=${token}`;
        try {
            const { data } = await axios.post(url, payload, { timeout: 10_000 });
            this.logger.log(`CAPI ${ev.eventName} ok: ${JSON.stringify(data)}`);
        } catch (e: any) {
            this.logger.error(
                `CAPI ${ev.eventName} failed: ${e?.response?.status} ` +
                    `${JSON.stringify(e?.response?.data || e.message)}`,
            );
            throw e;
        }
    }
}
