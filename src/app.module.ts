import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { TelegrafModule } from 'nestjs-telegraf';

import { RedisModule } from './redis/redis.module';
import { PrismaModule } from './prisma/prisma.module';
import { SettingsModule } from './settings/settings.module';
import { SettingsService } from './settings/settings.service';
import { CapiModule } from './capi/capi.module';
import { InvitePoolModule } from './invite-pool/invite-pool.module';
import { TrackingModule } from './tracking/tracking.module';
import { TelegramModule } from './telegram/telegram.module';

@Module({
    imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        ScheduleModule.forRoot(),

        RedisModule,
        PrismaModule,
        SettingsModule,

        TelegrafModule.forRootAsync({
            inject: [SettingsService],
            useFactory: async (settings: SettingsService) => ({
                token: await settings.getRequired('BOT_TOKEN'),
                launchOptions: {
                    allowedUpdates: ['chat_member', 'chat_join_request', 'message'],
                    dropPendingUpdates: true,
                },
            }),
        }),

        CapiModule,
        InvitePoolModule,
        TrackingModule,
        TelegramModule,
    ],
})
export class AppModule {}
