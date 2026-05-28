import { Global, Module } from '@nestjs/common';
import { SettingsService } from './settings.service';
import { SettingsController } from './settings.controller';
import { AdminGuard } from './admin.guard';

@Global()
@Module({
    controllers: [SettingsController],
    providers: [SettingsService, AdminGuard],
    exports: [SettingsService],
})
export class SettingsModule {}
