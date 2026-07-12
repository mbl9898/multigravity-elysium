// src/lib/antigravity/local_ls.ts
// Local Antigravity Language Server integration.
// Discovers running language_server processes and queries their local API ports
// to retrieve the precise weekly and 5-hour limits.

import { exec } from 'child_process';
import http from 'http';
import https from 'https';
import type { AccountQuota } from '@/types';

interface ProcessInfo {
  pid: number;
  csrfToken: string;
}

function execAsync(cmd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(cmd, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

/**
 * Find all running language_server processes and extract their PIDs and CSRF tokens.
 */
async function discoverProcesses(): Promise<ProcessInfo[]> {
  try {
    // List processes and filter for language_server
    const stdout = await execAsync('ps -ww -eo pid,ppid,args | grep -E "language_server|antigravity" | grep -v grep');
    const lines = stdout.trim().split('\n');
    const processes: ProcessInfo[] = [];

    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 3) continue;

      const pid = parseInt(parts[0], 10);
      const cmd = parts.slice(2).join(' ');

      const tokenMatch = cmd.match(/--csrf_token[=\s]+([a-f0-9-]+)/i);
      if (tokenMatch && tokenMatch[1] && !isNaN(pid)) {
        processes.push({
          pid,
          csrfToken: tokenMatch[1],
        });
      }
    }
    return processes;
  } catch {
    return [];
  }
}

/**
 * Get all listening ports for a specific PID.
 */
async function getProcessPorts(pid: number): Promise<number[]> {
  try {
    const stdout = await execAsync(`lsof -Pan -p ${pid} -i`);
    const ports: number[] = [];
    const lines = stdout.trim().split('\n');
    for (const line of lines) {
      const match = line.match(/127\.0\.0\.1:(\d+).*\(LISTEN\)|localhost:(\d+).*\(LISTEN\)/);
      if (match) {
        const port = parseInt(match[1] || match[2], 10);
        if (!ports.includes(port)) {
          ports.push(port);
        }
      }
    }
    return ports.sort((a, b) => a - b);
  } catch {
    return [];
  }
}

interface UserStatusResponse {
  userStatus?: {
    email?: string;
    cascadeModelConfigData?: {
      clientModelConfigs?: Array<{
        label?: string;
        quotaInfo?: {
          remainingFraction?: number;
          resetTime?: string;
        };
      }>;
    };
  };
}

/**
 * Query the local language server GetUserStatus Connect-RPC endpoint.
 */
function queryUserStatus(port: number, csrfToken: string): Promise<UserStatusResponse> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({});
    const options = {
      hostname: '127.0.0.1',
      port: port,
      path: '/exa.language_server_pb.LanguageServerService/GetUserStatus',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Connect-Protocol-Version': '1',
        'X-Codeium-Csrf-Token': csrfToken,
      },
      timeout: 1000,
    };

    // Try HTTPS first (Antigravity's default local server mode)
    const req = https.request({ ...options, rejectUnauthorized: false }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error('Failed to parse JSON response'));
          }
        } else {
          tryHttpFallback();
        }
      });
    });

    req.on('error', () => {
      tryHttpFallback();
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    req.write(body);
    req.end();

    function tryHttpFallback() {
      const fallbackReq = http.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              resolve(JSON.parse(data));
            } catch {
              reject(new Error('Failed to parse JSON response'));
            }
          } else {
            reject(new Error(`HTTP ${res.statusCode}`));
          }
        });
      });

      fallbackReq.on('error', (err) => reject(err));
      fallbackReq.on('timeout', () => {
        fallbackReq.destroy();
        reject(new Error('Request timeout'));
      });
      fallbackReq.write(body);
      fallbackReq.end();
    }
  });
}

export interface LocalQuotaResult {
  email: string;
  quota: AccountQuota;
}

/**
 * Scan all local language servers and retrieve quota information.
 */
export async function scanLocalLanguageServers(): Promise<LocalQuotaResult[]> {
  const processes = await discoverProcesses();
  const rawResults: LocalQuotaResult[] = [];

  for (const proc of processes) {
    const ports = await getProcessPorts(proc.pid);
    for (const port of ports) {
      try {
        const response = await queryUserStatus(port, proc.csrfToken);
        const userStatus = response?.userStatus;
        if (!userStatus || !userStatus.email) continue;

        const email = userStatus.email.toLowerCase().trim();
        const configs = userStatus.cascadeModelConfigData?.clientModelConfigs || [];

        // 1. Extract 5-hour and weekly limits from configs based on resetTime delay
        let gemini5h: number | null = null;
        let geminiReset5h: string | null = null;
        let geminiWeekly: number | null = null;
        let geminiResetWeekly: string | null = null;
        let geminiWeeklyStatus: 'ok' | 'exhausted' | 'unknown' = 'unknown';

        let anthropic5h: number | null = null;
        let anthropicReset5h: string | null = null;
        let anthropicWeekly: number | null = null;
        let anthropicResetWeekly: string | null = null;
        let anthropicWeeklyStatus: 'ok' | 'exhausted' | 'unknown' = 'unknown';

        for (const cfg of configs) {
          const label = cfg.label?.toLowerCase() || '';
          const quota = cfg.quotaInfo;

          if (label.includes('gemini')) {
            if (quota) {
              const fraction = quota.remainingFraction ?? 1.0;
              // If the reset time is 1.5+ days away, it's the weekly reset, otherwise 5h
              const resetTime = quota.resetTime;
              const resetDate = resetTime ? new Date(resetTime) : null;
              const daysDiff = resetDate ? (resetDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24) : 0;

              if (daysDiff > 1.5) {
                // True weekly window entry — use it for both 7d and 5h
                geminiWeekly = fraction;
                geminiResetWeekly = resetTime ?? null;
                geminiWeeklyStatus = fraction === 0 ? 'exhausted' : 'ok';
              } else {
                // 5h window — track the worst (lowest) fraction
                if (gemini5h === null || fraction < gemini5h) {
                  gemini5h = fraction;
                  geminiReset5h = resetTime ?? null;
                }
              }
            }
          } else if (label.includes('claude') || label.includes('gpt') || label.includes('opus') || label.includes('sonnet')) {
            // Note: Claude models omit remainingFraction when at 0% (exhausted)
            if (quota) {
              const fraction = quota.remainingFraction ?? 0.0;
              const resetTime = quota.resetTime;
              const resetDate = resetTime ? new Date(resetTime) : null;
              const daysDiff = resetDate ? (resetDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24) : 0;

              if (daysDiff > 1.5) {
                // True weekly window entry
                anthropicWeekly = fraction;
                anthropicResetWeekly = resetTime ?? null;
                anthropicWeeklyStatus = fraction === 0 ? 'exhausted' : 'ok';
              } else {
                // 5h window — track the worst (lowest) fraction across all Anthropic models
                if (anthropic5h === null || fraction < anthropic5h) {
                  anthropic5h = fraction;
                  anthropicReset5h = resetTime ?? null;
                }
              }
            } else {
              // Missing quotaInfo entirely usually means exhausted 5h limit
              if (anthropic5h === null) anthropic5h = 0.0;
            }
          }
        }

        // Standardize structure. Weekly values are left as parsed from the LS.
        // If not present in the LS, they remain null/unknown, allowing the remote-fetched weekly values to be merged.
        //
        // NOTE: Do NOT default remaining5h to 1.0 here. If no model configs were found
        // for a pool (e.g. no Claude model is active in any IDE window), the value must
        // stay null so that the merge logic in accounts.ts keeps the remote API value
        // instead of overriding it with a fake 100%.
        const quota: AccountQuota = {
          gemini: {
            remaining5h: gemini5h,   // null = no local data → remote value wins
            resetTime5h: geminiReset5h,
            remaining7d: geminiWeekly,
            resetTime7d: geminiResetWeekly,
            weeklyStatus: geminiWeeklyStatus,
          },
          anthropic: {
            remaining5h: anthropic5h, // null = no local data → remote value wins
            resetTime5h: anthropicReset5h,
            remaining7d: anthropicWeekly,
            resetTime7d: anthropicResetWeekly,
            weeklyStatus: anthropicWeeklyStatus,
          },
        };

        rawResults.push({ email, quota });
        break; // Successfully queried this process, move to next process
      } catch {
        // Port failed to query, try next port
      }
    }
  }

  // Merge results by email, picking the lowest non-null fraction for 5h and weekly
  const mergedMap = new Map<string, AccountQuota>();
  for (const item of rawResults) {
    const existing = mergedMap.get(item.email);
    if (!existing) {
      mergedMap.set(item.email, item.quota);
    } else {
      mergedMap.set(item.email, {
        gemini: {
          remaining5h: minFraction(item.quota.gemini.remaining5h, existing.gemini.remaining5h),
          resetTime5h: getWorseReset(item.quota.gemini.remaining5h, item.quota.gemini.resetTime5h, existing.gemini.remaining5h, existing.gemini.resetTime5h),
          remaining7d: minFraction(item.quota.gemini.remaining7d, existing.gemini.remaining7d),
          resetTime7d: getWorseReset(item.quota.gemini.remaining7d, item.quota.gemini.resetTime7d, existing.gemini.remaining7d, existing.gemini.resetTime7d),
          weeklyStatus: worstWeeklyStatus(item.quota.gemini.weeklyStatus, existing.gemini.weeklyStatus),
        },
        anthropic: {
          remaining5h: minFraction(item.quota.anthropic.remaining5h, existing.anthropic.remaining5h),
          resetTime5h: getWorseReset(item.quota.anthropic.remaining5h, item.quota.anthropic.resetTime5h, existing.anthropic.remaining5h, existing.anthropic.resetTime5h),
          remaining7d: minFraction(item.quota.anthropic.remaining7d, existing.anthropic.remaining7d),
          resetTime7d: getWorseReset(item.quota.anthropic.remaining7d, item.quota.anthropic.resetTime7d, existing.anthropic.remaining7d, existing.anthropic.resetTime7d),
          weeklyStatus: worstWeeklyStatus(item.quota.anthropic.weeklyStatus, existing.anthropic.weeklyStatus),
        },
      });
    }
  }

  return Array.from(mergedMap.entries()).map(([email, quota]) => ({ email, quota }));
}

function minFraction(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

function getWorseReset(aFraction: number | null, aReset: string | null, bFraction: number | null, bReset: string | null): string | null {
  if (aFraction === null) return bReset;
  if (bFraction === null) return aReset;
  return aFraction < bFraction ? aReset : bReset;
}

function worstWeeklyStatus(a: 'ok' | 'exhausted' | 'unknown', b: 'ok' | 'exhausted' | 'unknown'): 'ok' | 'exhausted' | 'unknown' {
  if (a === 'exhausted' || b === 'exhausted') return 'exhausted';
  if (a === 'ok' || b === 'ok') return 'ok';
  return 'unknown';
}
