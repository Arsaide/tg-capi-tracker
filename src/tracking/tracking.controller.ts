import { Body, Controller, Headers, Ip, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { TrackingService } from './tracking.service';
import { CapiService } from '../capi/capi.service';
import { SettingsService } from '../settings/settings.service';
import { AdminGuard } from '../settings/admin.guard';

interface TrackClickDto {
    fbclid?: string;
    fbp?: string;
    fbc?: string;
}

interface BotEventDto {
    clickId?: string;
    tgUserId?: number | string;
}

@Controller('track')
export class TrackingController {
    constructor(
        private readonly tracking: TrackingService,
        private readonly capi: CapiService,
        private readonly settings: SettingsService,
    ) {}

    /**
     * Called by the landing JS. Persists click context and returns a deep link
     * into the welcome bot: https://t.me/<WELCOME_BOT_USERNAME>?start=<clickId>.
     * The clickId travels as the bot's /start payload — that is the attribution key.
     * No CAPI event fires here: the site-stage event is PageView (browser pixel);
     * the server-side conversion (Lead) fires later, on the welcome-bot button press.
     */
    @Post('click')
    async click(
        @Body() dto: TrackClickDto,
        @Ip() ip: string,
        @Headers('user-agent') ua: string,
        @Req() req: Request,
    ) {
        const fwd = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim();
        const realIp = fwd || ip;

        const clickId = await this.tracking.createClick({
            fbclid: dto.fbclid,
            fbc: dto.fbc,
            fbp: dto.fbp,
            ip: realIp,
            ua,
        });

        const username = (await this.settings.getRequired('WELCOME_BOT_USERNAME')).replace(
            /^@/,
            '',
        );
        const url = `https://t.me/${username}?start=${clickId}`;

        // `inviteLink` is kept as a deprecated alias of `url` so existing landings
        // that read the old field keep working without a redeploy.
        return { ok: true, url, inviteLink: url, clickId };
    }

    /**
     * Called by the welcome bot when a user opens it via /start <clickId>.
     * Binds tg:{userId} -> clickId so the button press (and any later deep
     * events) can be attributed. No CAPI event fires here.
     */
    @Post('bot/start')
    @UseGuards(AdminGuard)
    async botStart(@Body() dto: BotEventDto) {
        if (!dto.clickId || dto.tgUserId == null) {
            return { ok: false, error: 'bad_request' };
        }
        const ctx = await this.tracking.getClick(dto.clickId);
        if (!ctx) {
            return { ok: false, error: 'click_expired' };
        }
        await this.tracking.linkUser(dto.tgUserId, dto.clickId);
        return { ok: true };
    }

    /**
     * Called by the welcome bot when the user presses the welcome button
     * ("🚀 ЗАПУСТИТЬ ИИ-ТЕРМИНАЛ") — i.e. enters the funnel via the bot.
     * This is the conversion: fires Lead with the click's attribution data
     * + external_id (the Telegram user id).
     */
    @Post('bot/activate')
    @UseGuards(AdminGuard)
    async botActivate(@Body() dto: BotEventDto) {
        if (!dto.clickId || dto.tgUserId == null) {
            return { ok: false, error: 'bad_request' };
        }
        const ctx = await this.tracking.getClick(dto.clickId);
        if (!ctx) {
            return { ok: false, error: 'click_expired' };
        }
        await this.tracking.linkUser(dto.tgUserId, dto.clickId);

        await this.capi.send({
            eventName: 'Lead',
            eventId: `lead_${dto.clickId}`,
            ctx: { ...ctx, tgUserId: dto.tgUserId },
        });

        return { ok: true };
    }
}
