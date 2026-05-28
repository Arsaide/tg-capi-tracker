import { Module } from '@nestjs/common';
import { TrackingService } from './tracking.service';
import { TrackingController } from './tracking.controller';
import { InvitePoolModule } from '../invite-pool/invite-pool.module';
import { CapiModule } from '../capi/capi.module';

@Module({
    imports: [InvitePoolModule, CapiModule],
    providers: [TrackingService],
    controllers: [TrackingController],
    exports: [TrackingService],
})
export class TrackingModule {}
