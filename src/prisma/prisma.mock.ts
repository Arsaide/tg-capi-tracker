import { PrismaService } from './prisma.service';

export function makePrismaMock(): { prisma: PrismaService; store: Map<string, string> } {
    const store = new Map<string, string>();

    const setting = {
        findUnique: jest.fn(async ({ where: { key } }: { where: { key: string } }) => {
            return store.has(key) ? { key, value: store.get(key), updatedAt: new Date() } : null;
        }),
        findMany: jest.fn(async () => {
            return Array.from(store.entries()).map(([key, value]) => ({
                key,
                value,
                updatedAt: new Date(),
            }));
        }),
        upsert: jest.fn(async ({ where: { key }, create, update }: any) => {
            const value: string = update?.value ?? create?.value;
            store.set(key, value);
            return { key, value, updatedAt: new Date() };
        }),
        deleteMany: jest.fn(async ({ where }: any) => {
            const keys: string[] = where?.key?.in ?? [];
            let count = 0;
            for (const k of keys) {
                if (store.delete(k)) count++;
            }
            return { count };
        }),
    };

    const prisma = {
        setting,
        $transaction: jest.fn(async (ops: Array<Promise<unknown>>) => Promise.all(ops)),
    } as unknown as PrismaService;

    return { prisma, store };
}
