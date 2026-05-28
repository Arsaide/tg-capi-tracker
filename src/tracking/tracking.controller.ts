import { Body, Controller, Headers, Ip, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { TrackingService } from './tracking.service';
import { InvitePoolService } from '../invite-pool/invite-pool.service';
import { CapiService } from '../capi/capi.service';

interface TrackClickDto {
    fbclid?: string;
    fbp?: string;
    fbc?: string;
}

@Controller('track')
export class TrackingController {
    constructor(
        private readonly tracking: TrackingService,
        private readonly pool: InvitePoolService,
        private readonly capi: CapiService,
    ) {}

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

        const inviteLink = await this.pool.take();
        if (!inviteLink) {
            return { ok: false, error: 'no_invite_link' };
        }
        await this.tracking.bindLink(inviteLink, clickId);

        const ctx = await this.tracking.getClick(clickId);
        if (ctx) {
            this.capi
                .send({ eventName: 'Lead', eventId: `lead_${clickId}`, ctx })
                .catch(() => undefined);
        }

        return { ok: true, inviteLink };
    }
}
