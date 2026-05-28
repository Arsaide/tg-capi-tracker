import { Module } from '@nestjs/common';
import { CapiService } from './capi.service';

@Module({
    providers: [CapiService],
    exports: [CapiService],
})
export class CapiModule {}
