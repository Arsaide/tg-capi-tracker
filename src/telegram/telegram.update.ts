import { Logger } from '@nestjs/common';
import { Ctx, On, Update } from 'nestjs-telegraf';
import { Context } from 'telegraf';
import { TrackingService } from '../tracking/tracking.service';
import { CapiService } from '../capi/capi.service';

@Update()
export class TelegramUpdate {
    private readonly logger = new Logger(TelegramUpdate.name);

    constructor(
        private readonly tracking: TrackingService,
        private readonly capi: CapiService,
    ) {}

    @On('chat_member')
    async onChatMember(@Ctx() ctx: Context) {
        const upd: any = (ctx.update as any).chat_member;
        if (!upd) return;

        const oldStatus = upd.old_chat_member?.status;
        const newStatus = upd.new_chat_member?.status;
        const user = upd.new_chat_member?.user;
        const inviteLink: string | undefined = upd.invite_link?.invite_link;

        const joined =
            (oldStatus === 'left' || oldStatus === 'kicked') &&
            (newStatus === 'member' || newStatus === 'restricted');

        if (!joined || !inviteLink || !user || user.is_bot) return;

        const match = await this.tracking.getByLink(inviteLink);
        if (!match) {
            this.logger.warn(`Join via untracked link: ${inviteLink}`);
            return;
        }

        await this.tracking.linkUser(user.id, match.clickId);

        const ctxData = { ...match.ctx, tgUserId: user.id };
        await this.capi
            .send({
                eventName: 'Subscribe',
                eventId: `sub_${match.clickId}`,
                ctx: ctxData,
            })
            .catch(e => this.logger.error(`CAPI subscribe failed: ${e?.message}`));

        this.logger.log(`Attributed join: user=${user.id} click=${match.clickId}`);
    }
}
