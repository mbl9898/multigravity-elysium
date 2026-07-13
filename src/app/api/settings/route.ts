// src/app/api/settings/route.ts
// GET  /api/settings  — Returns the current routing strategy settings.
// PUT  /api/settings  — Updates the routing strategy settings.
//
// Used by the RoutingStrategyDrawer component on the dashboard.

import { NextRequest } from 'next/server';
import {
  readRoutingSettings,
  writeRoutingSettings,
  type RoutingMode,
} from '@/lib/router/accountRouter';
import { prisma } from '@/lib/database/client';

const VALID_MODES: RoutingMode[] = ['smart', 'round-robin', 'locked', 'custom'];

export async function GET(): Promise<Response> {
  try {
    const settings = await readRoutingSettings();
    return Response.json(settings);
  } catch (err) {
    console.error('[/api/settings] GET error:', err);
    return Response.json({ error: String(err) }, { status: 500 });
  }
}

export async function PUT(req: NextRequest): Promise<Response> {
  try {
    const body = (await req.json()) as {
      mode?: string;
      lockedAccountId?: string | null;
      customAccountIds?: string[];
    };

    const mode = body.mode as RoutingMode;
    if (!VALID_MODES.includes(mode)) {
      return Response.json(
        { error: `Invalid mode. Must be one of: ${VALID_MODES.join(', ')}` },
        { status: 400 },
      );
    }

    const lockedAccountId = body.lockedAccountId ?? null;
    const customAccountIds: string[] = Array.isArray(body.customAccountIds)
      ? body.customAccountIds.filter((id) => typeof id === 'string')
      : [];

    // Validate that referenced account IDs actually exist
    if (mode === 'locked' && lockedAccountId) {
      const exists = await prisma.account.findUnique({
        where: { id: lockedAccountId },
        select: { id: true },
      });
      if (!exists) {
        return Response.json(
          { error: `Account ${lockedAccountId} not found` },
          { status: 404 },
        );
      }
    }

    if (mode === 'custom' && customAccountIds.length > 0) {
      const found = await prisma.account.findMany({
        where: { id: { in: customAccountIds } },
        select: { id: true },
      });
      const foundIds = new Set(found.map((a) => a.id));
      const missing = customAccountIds.filter((id) => !foundIds.has(id));
      if (missing.length > 0) {
        return Response.json(
          { error: `Account(s) not found: ${missing.join(', ')}` },
          { status: 404 },
        );
      }
    }

    await writeRoutingSettings({ mode, lockedAccountId, customAccountIds });
    const updated = await readRoutingSettings();
    return Response.json(updated);
  } catch (err) {
    console.error('[/api/settings] PUT error:', err);
    return Response.json({ error: String(err) }, { status: 500 });
  }
}
