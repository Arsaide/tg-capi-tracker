import { Module } from '@nestjs/common';
import { InvitePoolService } from './invite-pool.service';

@Module({
    providers: [InvitePoolService],
    exports: [InvitePoolService],
})
export class InvitePoolModule {}
