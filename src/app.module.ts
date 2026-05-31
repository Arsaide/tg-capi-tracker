import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { RedisModule } from './redis/redis.module';
import { PrismaModule } from './prisma/prisma.module';
import { SettingsModule } from './settings/settings.module';
import { CapiModule } from './capi/capi.module';
import { TrackingModule } from './tracking/tracking.module';

@Module({
    imports: [
        ConfigModule.forRoot({ isGlobal: true }),

        RedisModule,
        PrismaModule,
        SettingsModule,

        CapiModule,
        TrackingModule,
    ],
})
export class AppModule {}
