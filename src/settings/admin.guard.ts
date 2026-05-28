import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';

@Injectable()
export class AdminGuard implements CanActivate {
    constructor(private readonly config: ConfigService) {}

    canActivate(ctx: ExecutionContext): boolean {
        const expected = this.config.get<string>('ADMIN_TOKEN');
        if (!expected) {
            throw new UnauthorizedException('ADMIN_TOKEN is not set on the server');
        }
        const req = ctx.switchToHttp().getRequest<Request>();
        const auth = req.headers['authorization'];
        const provided =
            typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : undefined;
        if (!provided || provided !== expected) {
            throw new UnauthorizedException();
        }
        return true;
    }
}
