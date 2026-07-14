// src/lib/database/client.ts
// Prisma client singleton using libSQL driver adapter (Prisma 7 requirement).
// Uses a local SQLite file — no external database needed.

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import { PrismaClient } from '@prisma/client';
import { PrismaLibSql } from '@prisma/adapter-libsql';
import path from 'path';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function createPrismaClient(): PrismaClient {
  const dbPath = path.resolve(process.cwd(), 'prisma', 'dev.db');

  // PrismaLibSql is a factory — pass the config, not a pre-created client
  const adapter = new PrismaLibSql({ url: `file:${dbPath}` });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new PrismaClient({ adapter } as any);
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
