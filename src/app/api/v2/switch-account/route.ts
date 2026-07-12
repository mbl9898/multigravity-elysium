// src/app/api/v2/switch-account/route.ts
// POST /api/v2/switch-account — Switches the active account in Antigravity V2
//
// ── HOW IT WORKS ──────────────────────────────────────────────────────────────
// The Antigravity IDE language server reads its Google OAuth credentials from:
//   macOS Keychain  service="gemini"  account="antigravity"
//   Format: "go-keyring-base64:<base64-encoded-JSON>"
//
// The API:
//   1. Decrypts the refresh token for the requested account
//   2. Exchanges it for a fresh access token via Google OAuth2
//   3. Writes a Python script to /tmp and spawns it as a FULLY DETACHED process
//   4. Returns HTTP 200 immediately — before the detached script does anything
//   5. The detached script (survives Next.js server death):
//      a. Writes new credentials to macOS Keychain (go-keyring-base64 format)
//      b. Kills the language server hub process (SIGTERM)
//      c. Electron auto-restarts the LS → picks up new keychain entry
//   6. All steps are logged to /tmp/agy_switch.log

import { NextRequest, NextResponse } from 'next/server';
import { execSync, spawn } from 'child_process';
import { prisma } from '@/lib/database/client';
import { decrypt } from '@/lib/encryption';
import { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } from '@/lib/antigravity/auth';
import path from 'path';
import os from 'os';
import fs from 'fs';

// ── Route version — update this when making changes to verify hot-reload ──────
const ROUTE_VERSION = `v${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '.')}`;

// ── Persistent log file (survives server restarts) ────────────────────────────
const LOG_FILE = '/tmp/agy_switch.log';

function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  process.stdout.write(line);
  try { fs.appendFileSync(LOG_FILE, line); } catch { /* ignore */ }
}

// ── Google token refresh ──────────────────────────────────────────────────────
interface GoogleTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
  id_token?: string;
  scope?: string;
}

async function refreshGoogleToken(refreshToken: string): Promise<GoogleTokenResponse> {
  const body = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    grant_type: 'refresh_token',
  });

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Token refresh failed (${response.status}): ${err}`);
  }

  return response.json() as Promise<GoogleTokenResponse>;
}

// ── Detached Python script spawner ────────────────────────────────────────────
// Writes credentials to a JSON staging file, then spawns a fully detached
// Python process that outlives the Next.js server (which may die when the
// keychain write triggers V2's credential watcher → IDE reload).

function spawnKeychainWriter(stagingFile: string): void {
  const script = `
import base64, json, subprocess, sys, os
from datetime import datetime, timezone, timedelta

LOG = "/tmp/agy_switch.log"

def log(msg):
    line = f"[PYPROC {datetime.now().isoformat()}] {msg}\\n"
    sys.stdout.write(line)
    try:
        with open(LOG, "a") as f: f.write(line)
    except:
        pass

log(f"Script started. PID={os.getpid()}")

staging_file = sys.argv[1]
log(f"Reading staging file: {staging_file}")

try:
    with open(staging_file) as f:
        data = json.load(f)
    log(f"Staging data loaded for: {data.get('email')}")
except Exception as e:
    log(f"ERROR reading staging file: {e}")
    sys.exit(1)

at = data["access_token"]
rt = data["refresh_token"]
expires_in = data["expires_in"]

expiry = (datetime.now(timezone.utc) + timedelta(seconds=expires_in)).isoformat()
credential = {
    "token": {"access_token": at, "token_type": "Bearer", "refresh_token": rt, "expiry": expiry},
    "auth_method": "consumer"
}
kv = "go-keyring-base64:" + base64.b64encode(json.dumps(credential).encode()).decode()
log(f"Credential payload built. expiry={expiry}")

# Step 1: Write to macOS Keychain
log("Writing to macOS Keychain...")
r1 = subprocess.run(["security", "delete-generic-password", "-s", "gemini", "-a", "antigravity"], capture_output=True)
log(f"  delete-generic-password exit={r1.returncode}")

r2 = subprocess.run(["security", "add-generic-password", "-s", "gemini", "-a", "antigravity", "-w", kv], capture_output=True, text=True)
log(f"  add-generic-password exit={r2.returncode} stderr={r2.stderr.strip()!r}")

if r2.returncode != 0:
    log("ERROR: Keychain write failed!")
    sys.exit(1)

log("Keychain write SUCCESS")

# Step 2: Kill LS hub process
log("Looking for language server hub process...")
try:
    ps = subprocess.run(["ps", "-ww", "-eo", "pid,args"], capture_output=True, text=True)
    found = False
    for line in ps.stdout.splitlines():
        if "language_server" in line and "subclient_type hub" in line and "grep" not in line:
            pid = int(line.strip().split()[0])
            log(f"Found LS hub PID={pid}. Sending SIGTERM...")
            r3 = subprocess.run(["kill", "-TERM", str(pid)], capture_output=True)
            log(f"  kill exit={r3.returncode}")
            found = True
            break
    if not found:
        log("No LS hub process found (may already be dead)")
except Exception as e:
    log(f"ERROR killing LS: {e}")

# Cleanup staging file
try:
    os.unlink(staging_file)
    log(f"Staging file cleaned up: {staging_file}")
except:
    pass

log("Script complete.")
`;

  const scriptPath = path.join(os.tmpdir(), `agy_keychain_switch_${process.pid}.py`);
  log(`Writing detached Python script to: ${scriptPath}`);
  fs.writeFileSync(scriptPath, script, { mode: 0o700 });

  log(`Spawning detached process: python3 ${scriptPath} ${stagingFile}`);
  const child = spawn('python3', [scriptPath, stagingFile], {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  child.on('error', (err) => log(`Spawn error: ${err.message}`));
  log(`Detached process spawned. Child PID: ${child.pid}`);
  child.unref();
}

// ── GET — current active V2 account (reads keychain) ─────────────────────────
export async function GET() {
  log(`GET /api/v2/switch-account (route ${ROUTE_VERSION})`);
  try {
    const raw = execSync(
      'security find-generic-password -s "gemini" -a "antigravity" -w',
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();

    const PREFIX = 'go-keyring-base64:';
    if (raw.startsWith(PREFIX)) {
      const decoded = JSON.parse(
        Buffer.from(raw.slice(PREFIX.length), 'base64').toString('utf8')
      ) as { token?: { access_token?: string } };

      const at = decoded?.token?.access_token;
      if (at) {
        const infoRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
          headers: { Authorization: `Bearer ${at}` },
        });
        if (infoRes.ok) {
          const info = await infoRes.json() as { email?: string; name?: string };
          log(`GET → keychain email: ${info.email}`);
          return NextResponse.json({
            email: info.email ?? 'unknown',
            name: info.name ?? '',
            hasToken: true,
            source: 'keychain',
            routeVersion: ROUTE_VERSION,
          });
        }
      }
    }
  } catch (err) {
    log(`GET keychain error: ${String(err)}`);
  }

  return NextResponse.json({ email: 'unknown', name: '', hasToken: false, source: 'none', routeVersion: ROUTE_VERSION });
}

// ── POST — switch active V2 account ───────────────────────────────────────────
export async function POST(req: NextRequest) {
  log(`\n${'='.repeat(60)}`);
  log(`POST /api/v2/switch-account (route ${ROUTE_VERSION})`);

  try {
    const body = await req.json() as { accountId: string };
    const { accountId } = body;
    log(`Requested accountId: ${accountId}`);

    if (!accountId) {
      log('ERROR: accountId missing');
      return NextResponse.json({ error: 'accountId is required' }, { status: 400 });
    }

    // 1. Load account from DB
    log('Loading account from DB...');
    const account = await prisma.account.findUnique({ where: { id: accountId } });
    if (!account) {
      log(`ERROR: Account ${accountId} not found in DB`);
      return NextResponse.json({ error: 'Account not found' }, { status: 404 });
    }
    log(`Account found: ${account.email}`);

    // 2. Decrypt refresh token
    log('Decrypting refresh token...');
    const refreshToken = decrypt(account.encryptedRefreshToken);
    log(`Refresh token decrypted (${refreshToken.length} chars)`);

    // 3. Get fresh access token
    log('Refreshing access token via Google OAuth2...');
    const tokenData = await refreshGoogleToken(refreshToken);
    const accessToken = tokenData.access_token;
    const expiresIn = tokenData.expires_in ?? 3600;
    log(`Access token obtained (${accessToken.length} chars), expires_in=${expiresIn}`);

    // 4. Fetch display name
    let name = account.nickname ?? account.email.split('@')[0];
    try {
      const infoRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (infoRes.ok) {
        const info = await infoRes.json() as { name?: string; email?: string };
        if (info.name) name = info.name;
        log(`Userinfo: email=${info.email}, name=${info.name}`);
      }
    } catch (err) {
      log(`Userinfo fetch failed (non-fatal): ${String(err)}`);
    }

    // 5. Write credentials to staging JSON file
    const stagingFile = path.join(os.tmpdir(), `agy_staging_${process.pid}_${Date.now()}.json`);
    log(`Writing staging file: ${stagingFile}`);
    fs.writeFileSync(stagingFile, JSON.stringify({
      email: account.email,
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: expiresIn,
    }), { mode: 0o600 });
    log('Staging file written.');

    // 6. Spawn detached writer (returns immediately — script runs in background)
    spawnKeychainWriter(stagingFile);

    // 7. Return success immediately — before the detached script touches anything
    log(`Returning HTTP 200. Detached script will handle keychain+LS kill.`);
    return NextResponse.json({
      success: true,
      email: account.email,
      name,
      routeVersion: ROUTE_VERSION,
      logFile: LOG_FILE,
      message: `Switching to ${account.email}… Antigravity V2 will reload shortly.`,
    });

  } catch (err) {
    log(`UNHANDLED ERROR: ${String(err)}`);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
