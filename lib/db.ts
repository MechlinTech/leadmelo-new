import { PrismaClient } from '@prisma/client';

const globalDb = globalThis as unknown as { prisma?: PrismaClient };
export const db = globalDb.prisma ?? new PrismaClient();
globalDb.prisma = db;
