import { BadRequestException, Body, Controller, Get, Post, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { AdminGuard } from './admin.guard';
import { SettingKey, SettingsService, SETTINGS } from './settings.service';

const VALID_KEYS = new Set<string>(SETTINGS.map(s => s.key));

@Controller('admin')
export class SettingsController {
    constructor(private readonly settings: SettingsService) {}

    @Get()
    async ui(@Res() res: Response): Promise<void> {
        const html = await fs.promises.readFile(path.join(__dirname, 'admin.html'), 'utf8');
        res.type('html').send(html);
    }

    @Get('settings')
    @UseGuards(AdminGuard)
    async list() {
        return { settings: await this.settings.listForAdmin() };
    }

    @Post('settings')
    @UseGuards(AdminGuard)
    async save(@Body() body: Record<string, unknown>) {
        if (!body || typeof body !== 'object') {
            throw new BadRequestException('Body must be a JSON object');
        }
        const values: Partial<Record<SettingKey, string | number | null>> = {};
        for (const [k, v] of Object.entries(body)) {
            if (!VALID_KEYS.has(k)) continue;
            if (v == null || v === '') {
                values[k as SettingKey] = null;
                continue;
            }
            if (typeof v !== 'string' && typeof v !== 'number') {
                throw new BadRequestException(`${k} must be string or number`);
            }
            values[k as SettingKey] = v;
        }
        try {
            await this.settings.setMany(values);
        } catch (e: any) {
            throw new BadRequestException(e?.message || 'Invalid settings');
        }
        return { ok: true };
    }
}
