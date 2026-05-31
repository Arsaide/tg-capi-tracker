import { Module } from '@nestjs/common';
import { TrackingService } from './tracking.service';
import { TrackingController } from './tracking.controller';
import { CapiModule } from '../capi/capi.module';
import { AdminGuard } from '../settings/admin.guard';

@Module({
    imports: [CapiModule],
    providers: [TrackingService, AdminGuard],
    controllers: [TrackingController],
    exports: [TrackingService],
})
export class TrackingModule {}
