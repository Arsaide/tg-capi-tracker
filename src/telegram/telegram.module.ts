import { Module } from '@nestjs/common';
import { TelegramUpdate } from './telegram.update';
import { TrackingModule } from '../tracking/tracking.module';
import { CapiModule } from '../capi/capi.module';

@Module({
    imports: [TrackingModule, CapiModule],
    providers: [TelegramUpdate],
})
export class TelegramModule {}
