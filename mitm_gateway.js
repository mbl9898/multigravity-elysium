/* eslint-disable @typescript-eslint/no-require-imports */
// mitm_gateway.js
// A transparent DNS-interception HTTPS gateway for Antigravity V2.
// Redirects Google AI domains to localhost at the OS socket layer.
//
// Usage:
//   sudo node mitm_gateway.js
//
// Requires administrator privileges to bind to port 443 and edit /etc/hosts.

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { execSync } = require('child_process');
const dns = require('dns');
const { createClient } = require('@libsql/client');

const HOSTS_FILE = '/etc/hosts';
const CERT_DIR = path.join(__dirname, '.certs');
const CERT_FILE = path.join(CERT_DIR, 'mitm.crt');
const KEY_FILE = path.join(CERT_DIR, 'mitm.key');
const DB_PATH = path.join(__dirname, 'prisma/dev.db');
const dbClient = createClient({ url: `file:${DB_PATH}` });

const TARGET_DOMAINS = [
  'cloudcode-pa.googleapis.com',
  'daily-cloudcode-pa.googleapis.com',
  'daily-cloudcode-pa.sandbox.googleapis.com',
  'generativelanguage.googleapis.com',
  'appsgenaiserver-pa.clients6.google.com',
  'labs.google'
];

// Configure custom DNS resolver pointing to Cloudflare to bypass local /etc/hosts
const resolver = new dns.Resolver();
resolver.setServers(['1.1.1.1']);

function log(msg) {
  console.log(`[MITM Gateway] ${new Date().toISOString()} | ${msg}`);
}

// Ensure administrator privileges
if (process.getuid() !== 0) {
  console.error('CRITICAL: This gateway must be run with root privileges to bind to port 443 and edit /etc/hosts.');
  console.error('Please run: sudo node mitm_gateway.js');
  process.exit(1);
}

// 1. Load .env.local to get ENCRYPTION_KEY
function loadEnv() {
  const envPath = path.join(__dirname, '.env.local');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const match = line.match(/^\s*([^#=]+)\s*=\s*(.*)$/);
      if (match) {
        const key = match[1].trim();
        let val = match[2].trim();
        if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
        if (val.startsWith("'") && val.endsWith("'")) val = val.slice(1, -1);
        process.env[key] = val;
      }
    }
  }
}

// 2. Decrypt encrypted refresh token
function decrypt(blob) {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error('Invalid or missing ENCRYPTION_KEY in .env.local');
  }
  const key = Buffer.from(hex, 'hex');
  const packed = Buffer.from(blob, 'base64');

  const iv = packed.subarray(0, 12);
  const authTag = packed.subarray(12, 12 + 16);
  const ciphertext = packed.subarray(12 + 16);

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final()
  ]);
  return decrypted.toString('utf8');
}

// 3. Refresh Access Token from Google
function refreshGoogleAccessToken(refreshToken) {
  return new Promise((resolve, reject) => {
    const fallbackClientId = Buffer.from('MTA3MTAwNjA2MDU5MS10bWhzc2luMmgyMWxjcmUyMzV2dG9sb2poNGc0MDNlcC5hcHBzLmdvb2dsZXVzZXJjb250ZW50LmNvbQ==', 'base64').toString('utf8');
    const fallbackClientSecret = Buffer.from('R09DU1BYLUs1OEZXUjQ4NkxkTEoxbUxCOHNYQzR6cURBZg==', 'base64').toString('utf8');
    
    const clientId = process.env.GOOGLE_CLIENT_ID || fallbackClientId;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET || fallbackClientSecret;

    const postData = new URLSearchParams({
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token'
    }).toString();

    const req = https.request({
      hostname: 'oauth2.googleapis.com',
      path: '/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData)
      }
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          return reject(new Error(`Google token refresh failed: ${res.statusCode} ${body}`));
        }
        try {
          const parsed = JSON.parse(body);
          resolve(parsed.access_token);
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

// 4. Generate and Trust SSL Certificates
function setupCertificates() {
  if (!fs.existsSync(CERT_DIR)) {
    fs.mkdirSync(CERT_DIR);
  }

  let needRegen = false;
  if (fs.existsSync(CERT_FILE)) {
    try {
      const details = execSync(`openssl x509 -in "${CERT_FILE}" -text -noout`).toString();
      if (!details.includes('Subject Alternative Name')) {
        log('Existing SSL certificate is missing Subject Alternative Name. Triggering regeneration...');
        needRegen = true;
      }
    } catch (e) {
      log(`Error inspecting certificate: ${e.message}. Triggering regeneration...`);
      needRegen = true;
    }
  } else {
    needRegen = true;
  }

  if (needRegen) {
    if (fs.existsSync(CERT_FILE)) fs.unlinkSync(CERT_FILE);
    if (fs.existsSync(KEY_FILE)) fs.unlinkSync(KEY_FILE);

    log('Generating self-signed SSL certificates for Google domains...');
    const extFile = path.join(CERT_DIR, 'openssl.ext');
    const extContent = `
authorityKeyIdentifier=keyid,issuer
basicConstraints=CA:FALSE
keyUsage = digitalSignature, nonRepudiation, keyEncipherment, dataEncipherment
subjectAltName = @alt_names

[alt_names]
DNS.1 = *.googleapis.com
DNS.2 = *.google.com
DNS.3 = *.clients6.google.com
DNS.4 = labs.google
`;
    fs.writeFileSync(extFile, extContent.trim());

    execSync(`openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
      -keyout "${KEY_FILE}" -out "${CERT_FILE}" \
      -subj "/CN=Google MITM Proxy/O=Elysium/C=US" \
      -addext "subjectAltName = DNS:*.googleapis.com,DNS:daily-cloudcode-pa.googleapis.com,DNS:*.google.com,DNS:*.clients6.google.com,DNS:labs.google" 2>/dev/null`);

    log('Adding certificate to macOS System Keychain...');
    execSync(`security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain "${CERT_FILE}"`);
    log('SSL Certificates successfully trusted.');
  } else {
    log('Using existing SSL certificates (SAN-valid).');
  }
}

// 5. DNS Redirect (/etc/hosts helper)
let originalHostsContent = '';
function activateDnsRedirect() {
  log('Backing up and updating /etc/hosts...');
  originalHostsContent = fs.readFileSync(HOSTS_FILE, 'utf8');

  let newEntries = '\n# --- Elysium MITM Gateway ---';
  for (const domain of TARGET_DOMAINS) {
    if (!originalHostsContent.includes(domain)) {
      newEntries += `\n127.0.0.1 ${domain}`;
    }
  }
  newEntries += '\n# -----------------------------\n';

  fs.appendFileSync(HOSTS_FILE, newEntries);
  log('DNS redirection activated. Target domains now point to 127.0.0.1.');
}

function restoreDnsRedirect() {
  if (originalHostsContent) {
    log('Restoring original /etc/hosts...');
    fs.writeFileSync(HOSTS_FILE, originalHostsContent, 'utf8');
    log('/etc/hosts successfully restored.');
  }
}

// Helper to determine quota pool from model name
function getPool(model) {
  if (model && model.toLowerCase().includes('claude')) {
    return 'anthropic';
  }
  return 'gemini';
}

// 6. Retrieve a healthy pooled account from SQLite based on requested model
async function getPooledAccountForModel(model, excludedAccountIds = []) {
  const pool = getPool(model);
  const result = await dbClient.execute(
    "SELECT id, email, encryptedRefreshToken, projectId, quotaJson FROM accounts WHERE isHealthy = 1"
  );
  
  const candidates = result.rows.filter(row => {
    if (excludedAccountIds.includes(row.id)) return false; // Skip already tried
    if (!row.quotaJson) return true;
    try {
      const quota = JSON.parse(row.quotaJson);
      const pq = quota[pool];
      if (!pq) return true;
      if (pq.weeklyStatus === 'exhausted') return false;
      if (pq.remaining5h !== null && pq.remaining5h <= 0) return false;
      return true;
    } catch {
      return true;
    }
  });

  if (candidates.length === 0) {
    throw new Error(`No healthy accounts available with remaining quota for pool: ${pool}`);
  }

  // Select the first eligible candidate
  return candidates[0];
}

// Helper to mark a pool as exhausted for a specific account in the DB
async function markAccountExhausted(accountId, pool) {
  try {
    const result = await dbClient.execute({
      sql: "SELECT quotaJson FROM accounts WHERE id = ?",
      args: [accountId]
    });
    if (!result.rows || result.rows.length === 0) return;
    
    const row = result.rows[0];
    let quota = {
      gemini: { remaining5h: null, resetTime5h: null, remaining7d: null, resetTime7d: null, weeklyStatus: 'unknown' },
      anthropic: { remaining5h: null, resetTime5h: null, remaining7d: null, resetTime7d: null, weeklyStatus: 'unknown' }
    };
    if (row.quotaJson) {
      try { quota = JSON.parse(row.quotaJson); } catch { /* ignore */ }
    }
    
    quota[pool] = {
      ...quota[pool],
      weeklyStatus: 'exhausted',
      remaining5h: 0
    };

    await dbClient.execute({
      sql: "UPDATE accounts SET quotaJson = ? WHERE id = ?",
      args: [JSON.stringify(quota), accountId]
    });
    log(`Marked account ${accountId} as exhausted in pool: ${pool}`);
  } catch (err) {
    log(`Failed to mark account ${accountId} as exhausted: ${err.message}`);
  }
}

// Resolve real IP of target host using Cloudflare DNS
function resolveRealIp(hostname) {
  return new Promise((resolve, reject) => {
    resolver.resolve4(hostname, (err, addresses) => {
      if (err || !addresses.length) return reject(err || new Error('No IP found'));
      resolve(addresses[0]);
    });
  });
}

const learnedCache = new Set();
const http = require('http');

function triggerAutoLearn(token, projectId) {
  const cacheKey = `${token}:${projectId}`;
  if (learnedCache.has(cacheKey)) return;
  learnedCache.add(cacheKey);

  log(`[Auto-Learn Trigger] Sending update for project ID: ${projectId}`);
  const apiReq = http.request({
    hostname: '127.0.0.1',
    port: 39281,
    path: '/api/v2/update-project',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    }
  });
  apiReq.on('error', (err) => log(`[Auto-Learn Error] Failed to send: ${err.message}`));
  apiReq.write(JSON.stringify({ accessToken: token, projectId }));
  apiReq.end();
}

// 7. Start HTTPS Server on Port 443
function startHttpsGateway() {
  const options = {
    key: fs.readFileSync(KEY_FILE),
    cert: fs.readFileSync(CERT_FILE),
  };

  const server = https.createServer(options, (req, res) => {
    const rawTargetHost = req.headers.host || '';
    const cleanHost = rawTargetHost.split(':')[0]; // Strip :443 port if present
    const path = req.url;

    log(`Intercepted request: ${req.method} to https://${cleanHost}${path}`);

    // --- Quota Interception Bypass (Milestone 3 Fix) ---
    if (path.includes('loadCodeAssist') || path.includes('retrieveUserQuotaSummary')) {
      log(`Bypassing token swapping for metadata/quota check path: ${path}`);
      
      let reqBody = '';
      req.on('data', chunk => reqBody += chunk);
      req.on('end', async () => {
        try {
          const realIp = await resolveRealIp(cleanHost);

          // ── Auto-Learn Project ID from client's retrieveUserQuotaSummary request ─────
          if (path.includes('retrieveUserQuotaSummary')) {
            try {
              const bodyJson = JSON.parse(reqBody);
              const incomingProjectId = bodyJson.project;
              const authHeader = req.headers['authorization'];
              if (incomingProjectId && authHeader && authHeader.startsWith('Bearer ')) {
                const token = authHeader.substring(7);
                triggerAutoLearn(token, incomingProjectId);
              }
            } catch (e) {
              log(`[Auto-Learn Error] Parsing failed: ${e.message}`);
            }
          }

          const proxyReq = https.request({
            hostname: realIp,
            port: 443,
            path: path,
            method: req.method,
            headers: req.headers, // Maintain original client Authorization header
            servername: cleanHost,
            rejectUnauthorized: false
          }, (proxyRes) => {
            res.writeHead(proxyRes.statusCode, proxyRes.headers);
            proxyRes.pipe(res);
          });

          proxyReq.on('error', (err) => {
            log(`Quota check proxy error: ${err.message}`);
            res.writeHead(502);
            res.end();
          });

          proxyReq.write(reqBody);
          proxyReq.end();
        } catch (err) {
          log(`Quota check bypass resolution error: ${err.message}`);
          res.writeHead(500);
          res.end();
        }
      });
      return;
    }
    // ----------------------------------------------------

    let reqBody = '';
    req.on('data', chunk => reqBody += chunk);
    req.on('end', async () => {
      let model = 'gemini-3-flash';
      try {
        const parsed = JSON.parse(reqBody);
        model = parsed.model || (parsed.request && parsed.request.model) || model;
      } catch { /* ignore */ }
      const pool = getPool(model);

      let attempt = 0;
      const maxRetries = 5;
      const triedAccountIds = [];

      const executeRequest = async () => {
        try {
          // 1. Resolve real destination IP
          const realIp = await resolveRealIp(cleanHost);

          // 2. Fetch account & generate access token based on model pool
          const pooledAccount = await getPooledAccountForModel(model, triedAccountIds);
          const decryptedRefreshToken = decrypt(pooledAccount.encryptedRefreshToken);
          const accessToken = await refreshGoogleAccessToken(decryptedRefreshToken);

          log('Attempt ' + (attempt + 1) + ': Routing model ' + model + ' using pooled account: ' + pooledAccount.email);

          // 3. Swap headers and body project ID
          let reqBodySwapped = reqBody;
          const headers = { ...req.headers };
          headers['host'] = cleanHost;
          headers['authorization'] = `Bearer ${accessToken}`;

          if (pooledAccount.projectId) {
            headers['x-goog-user-project'] = pooledAccount.projectId;
            try {
              const bodyJson = JSON.parse(reqBody);
              if (bodyJson.project) {
                bodyJson.project = pooledAccount.projectId;
                log(`[Proxy Swap] Swapped project in JSON body to: ${pooledAccount.projectId}`);
              }
              
              // Model fallback mapping for Google One AI Pro accounts
              if (bodyJson.model) {
                const orig = bodyJson.model;
                if (orig === 'gemini-3.5-flash' || orig === 'gemini-3.5-flash-low') {
                  bodyJson.model = 'gemini-3-flash';
                  log(`[Model Fallback] Mapping ${orig} -> gemini-3-flash`);
                } else if (orig === 'gemini-3.5-flash-medium') {
                  bodyJson.model = 'gemini-3.1-pro-low';
                  log(`[Model Fallback] Mapping ${orig} -> gemini-3.1-pro-low`);
                }
              }
              if (bodyJson.request && bodyJson.request.model) {
                const orig = bodyJson.request.model;
                if (orig === 'gemini-3.5-flash' || orig === 'gemini-3.5-flash-low') {
                  bodyJson.request.model = 'gemini-3-flash';
                  log(`[Model Fallback] Mapping request.model ${orig} -> gemini-3-flash`);
                } else if (orig === 'gemini-3.5-flash-medium') {
                  bodyJson.request.model = 'gemini-3.1-pro-low';
                  log(`[Model Fallback] Mapping request.model ${orig} -> gemini-3.1-pro-low`);
                }
              }
              
              reqBodySwapped = JSON.stringify(bodyJson);
            } catch { /* ignore non-JSON or other formats */ }
          }
          headers['content-length'] = Buffer.byteLength(reqBodySwapped);

          // 4. Proxy request
          const proxyReq = https.request({
            hostname: realIp,
            port: 443,
            path: path,
            method: req.method,
            headers: headers,
            servername: cleanHost, // Clean hostname without port for TLS SNI
            rejectUnauthorized: false
          }, async (proxyRes) => {
            if (proxyRes.statusCode === 429 || proxyRes.statusCode === 403 || proxyRes.statusCode === 404) {
              log(`Account ${pooledAccount.email} returned HTTP ${proxyRes.statusCode}. Retrying next account...`);
              if (proxyRes.statusCode === 429) {
                await markAccountExhausted(pooledAccount.id, pool);
              }
              triedAccountIds.push(pooledAccount.id);
              attempt++;
              if (attempt < maxRetries) {
                executeRequest(); // Recursive retry
               } else {
                 res.writeHead(proxyRes.statusCode, proxyRes.headers);
                 proxyRes.pipe(res);
               }
               return;
             }

             res.writeHead(proxyRes.statusCode, proxyRes.headers);
             proxyRes.pipe(res);
           });

           proxyReq.on('error', (err) => {
             log(`Proxy request error: ${err.message}. Retrying...`);
             attempt++;
             if (attempt < maxRetries) {
               executeRequest();
             } else {
               res.writeHead(502);
               res.end('Bad Gateway');
             }
           });

           proxyReq.write(reqBodySwapped);
          proxyReq.end();
        } catch (err) {
          log(`Interception gateway error: ${err.message}`);
          res.writeHead(500);
          res.end(`Gateway Error: ${err.message}`);
        }
      };

      executeRequest();
    });
  });

  server.listen(443, '127.0.0.1', () => {
    log('Transparent HTTPS gateway listening on 127.0.0.1:443.');
  });

  server.on('clientError', (err, socket) => {
    if (err.code !== 'ECONNRESET') {
      log(`TLS handshake/client error: ${err.message} (${err.code})`);
    }
    socket.destroy();
  });
}

// Cleanup & Graceful Shutdown
function cleanup() {
  log('Shutting down gracefully...');
  restoreDnsRedirect();
  process.exit(0);
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

// Run
loadEnv();
setupCertificates();
activateDnsRedirect();
startHttpsGateway();
