import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AdminGuard } from './admin.guard';

function ctxFor(headers: Record<string, string> = {}): ExecutionContext {
    return {
        switchToHttp: () => ({ getRequest: () => ({ headers }) }),
    } as unknown as ExecutionContext;
}

function guardWith(adminToken: string | undefined): AdminGuard {
    const config = { get: () => adminToken } as unknown as ConfigService;
    return new AdminGuard(config);
}

describe('AdminGuard', () => {
    it('rejects when ADMIN_TOKEN is not configured on the server', () => {
        const guard = guardWith(undefined);
        expect(() => guard.canActivate(ctxFor({ authorization: 'Bearer anything' }))).toThrow(
            UnauthorizedException,
        );
    });

    it('rejects requests with no Authorization header', () => {
        const guard = guardWith('secret');
        expect(() => guard.canActivate(ctxFor())).toThrow(UnauthorizedException);
    });

    it('rejects non-Bearer schemes', () => {
        const guard = guardWith('secret');
        expect(() => guard.canActivate(ctxFor({ authorization: 'Basic secret' }))).toThrow(
            UnauthorizedException,
        );
    });

    it('rejects mismatched tokens', () => {
        const guard = guardWith('secret');
        expect(() => guard.canActivate(ctxFor({ authorization: 'Bearer wrong' }))).toThrow(
            UnauthorizedException,
        );
    });

    it('rejects empty bearer value', () => {
        const guard = guardWith('secret');
        expect(() => guard.canActivate(ctxFor({ authorization: 'Bearer ' }))).toThrow(
            UnauthorizedException,
        );
    });

    it('allows matching bearer', () => {
        const guard = guardWith('secret');
        expect(guard.canActivate(ctxFor({ authorization: 'Bearer secret' }))).toBe(true);
    });
});
