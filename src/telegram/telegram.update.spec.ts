import { Context } from 'telegraf';
import { TelegramUpdate } from './telegram.update';
import { TrackingService } from '../tracking/tracking.service';
import { CapiService } from '../capi/capi.service';

interface MemberPayload {
    oldStatus?: string;
    newStatus?: string;
    user?: { id: number; is_bot?: boolean };
    inviteLink?: string;
}

function makeCtx(p?: MemberPayload): Context {
    if (!p) return { update: {} } as unknown as Context;
    return {
        update: {
            chat_member: {
                old_chat_member: p.oldStatus ? { status: p.oldStatus } : undefined,
                new_chat_member: { status: p.newStatus, user: p.user },
                invite_link: p.inviteLink ? { invite_link: p.inviteLink } : undefined,
            },
        },
    } as unknown as Context;
}

describe('TelegramUpdate.onChatMember', () => {
    let tracking: jest.Mocked<TrackingService>;
    let capi: jest.Mocked<CapiService>;
    let handler: TelegramUpdate;

    beforeEach(() => {
        tracking = {
            getByLink: jest.fn(),
            linkUser: jest.fn(),
        } as unknown as jest.Mocked<TrackingService>;
        capi = {
            send: jest.fn().mockResolvedValue(undefined),
        } as unknown as jest.Mocked<CapiService>;
        handler = new TelegramUpdate(tracking, capi);
    });

    it('ignores updates without a chat_member payload', async () => {
        await handler.onChatMember(makeCtx());
        expect(tracking.getByLink).not.toHaveBeenCalled();
        expect(capi.send).not.toHaveBeenCalled();
    });

    it('ignores when transition is not a join (e.g. member -> left)', async () => {
        await handler.onChatMember(
            makeCtx({
                oldStatus: 'member',
                newStatus: 'left',
                user: { id: 1 },
                inviteLink: 'https://t.me/+x',
            }),
        );
        expect(tracking.getByLink).not.toHaveBeenCalled();
    });

    it('ignores when invite_link is absent (joined via shared/manual link)', async () => {
        await handler.onChatMember(
            makeCtx({
                oldStatus: 'left',
                newStatus: 'member',
                user: { id: 1 },
            }),
        );
        expect(tracking.getByLink).not.toHaveBeenCalled();
    });

    it('ignores bot users', async () => {
        await handler.onChatMember(
            makeCtx({
                oldStatus: 'left',
                newStatus: 'member',
                user: { id: 1, is_bot: true },
                inviteLink: 'https://t.me/+x',
            }),
        );
        expect(tracking.getByLink).not.toHaveBeenCalled();
    });

    it('logs and exits when invite link is not tracked', async () => {
        tracking.getByLink.mockResolvedValue(null);
        await handler.onChatMember(
            makeCtx({
                oldStatus: 'kicked',
                newStatus: 'member',
                user: { id: 1 },
                inviteLink: 'https://t.me/+orphan',
            }),
        );
        expect(tracking.getByLink).toHaveBeenCalledWith('https://t.me/+orphan');
        expect(tracking.linkUser).not.toHaveBeenCalled();
        expect(capi.send).not.toHaveBeenCalled();
    });

    it('accepts kicked -> restricted as a join transition', async () => {
        tracking.getByLink.mockResolvedValue({
            clickId: 'cid-1',
            ctx: { ts: 1, fbclid: 'CL' },
        });
        await handler.onChatMember(
            makeCtx({
                oldStatus: 'kicked',
                newStatus: 'restricted',
                user: { id: 555 },
                inviteLink: 'https://t.me/+a',
            }),
        );
        expect(tracking.linkUser).toHaveBeenCalledWith(555, 'cid-1');
        expect(capi.send).toHaveBeenCalled();
    });

    it('on happy path: links user, fires Subscribe with sub_<clickId> dedup id', async () => {
        tracking.getByLink.mockResolvedValue({
            clickId: 'cid-xyz',
            ctx: { ts: 1234, fbclid: 'CL', ip: '8.8.8.8' },
        });
        await handler.onChatMember(
            makeCtx({
                oldStatus: 'left',
                newStatus: 'member',
                user: { id: 42 },
                inviteLink: 'https://t.me/+good',
            }),
        );
        expect(tracking.linkUser).toHaveBeenCalledWith(42, 'cid-xyz');
        expect(capi.send).toHaveBeenCalledWith({
            eventName: 'Subscribe',
            eventId: 'sub_cid-xyz',
            ctx: { ts: 1234, fbclid: 'CL', ip: '8.8.8.8', tgUserId: 42 },
        });
    });

    it('swallows CAPI errors (does not throw out of the handler)', async () => {
        tracking.getByLink.mockResolvedValue({ clickId: 'cid', ctx: { ts: 0 } });
        capi.send.mockRejectedValueOnce(new Error('CAPI down'));
        await expect(
            handler.onChatMember(
                makeCtx({
                    oldStatus: 'left',
                    newStatus: 'member',
                    user: { id: 1 },
                    inviteLink: 'https://t.me/+x',
                }),
            ),
        ).resolves.toBeUndefined();
    });
});
