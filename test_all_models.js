#!/usr/bin/env node
// test_all_models.js
// Standalone script to test model routing and authentication across all accounts in the pool.

/* eslint-disable @typescript-eslint/no-require-imports */
const { execSync } = require('child_process');
const os = require('os');
const path = require('path');

const DB_PATH = path.join(os.homedir(), '.multigravity-elysium', 'prisma', 'dev.db');
const BASE_URL = 'http://localhost:39281';

const MODELS_TO_TEST = [
  'gemini-3-flash',
  'gemini-3.5-flash',
  'gemini-3.5-flash-medium',
  'gemini-3.1-pro-low',
  'claude-sonnet-4-6',
  'gpt-oss-120b-medium'
];

async function testModelForAccount(accountId, email, model) {
  try {
    const res = await fetch(`${BASE_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountId,
        model,
        messages: [{ role: 'user', content: 'Ping. Reply with exactly one word: "OK".' }]
      })
    });

    const text = await res.text();
    if (!res.ok) {
      let errMsg = text;
      try {
        const parsed = JSON.parse(text);
        errMsg = parsed.error || text;
      } catch {}
      return { ok: false, error: errMsg };
    }

    if (text.includes('"error"') || text.includes('Unknown model') || text.includes('failed')) {
      return { ok: false, error: text.slice(0, 100) };
    }

    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function run() {
  console.log('=== Multigravity Elysium Model & Account Tester ===');
  
  let accounts = [];
  try {
    const raw = execSync(`sqlite3 ${DB_PATH} "select id, email from accounts;" -json`).toString();
    accounts = JSON.parse(raw);
  } catch (err) {
    console.error('ERROR: Failed to read accounts from SQLite database:', err.message);
    process.exit(1);
  }

  if (accounts.length === 0) {
    console.log('No accounts found in the database.');
    return;
  }

  console.log(`Found ${accounts.length} account(s). Starting sequential tests...\n`);

  const results = {};

  for (const acc of accounts) {
    console.log(`Testing account: ${acc.email} (${acc.id})...`);
    results[acc.email] = {};
    
    for (const model of MODELS_TO_TEST) {
      process.stdout.write(`  - ${model}: `);
      const res = await testModelForAccount(acc.id, acc.email, model);
      if (res.ok) {
        process.stdout.write('\x1b[32m✔ SUCCESS\x1b[0m\n');
        results[acc.email][model] = '✔';
      } else {
        process.stdout.write(`\x1b[31m✘ FAILED\x1b[0m (${res.error})\n`);
        results[acc.email][model] = '✘';
      }
    }
    console.log('');
  }

  console.log('=== Summary Matrix ===\n');
  
  // Print header row
  const colWidth = 24;
  const emailWidth = 32;
  const headers = ['Account \\ Model', ...MODELS_TO_TEST];
  const headerStr = [
    headers[0].padEnd(emailWidth),
    ...headers.slice(1).map(h => h.padEnd(colWidth))
  ].join(' | ');
  
  console.log(headerStr);
  console.log('='.repeat(headerStr.length));

  for (const email in results) {
    const rowCells = [email.padEnd(emailWidth)];
    for (const model of MODELS_TO_TEST) {
      const status = results[email][model];
      const coloredStatus = status === '✔' ? '\x1b[32m✔\x1b[0m' : '\x1b[31m✘\x1b[0m';
      rowCells.push(coloredStatus.padEnd(colWidth + 9)); // padding account for ANSI color codes escape overhead
    }
    console.log(rowCells.join(' | '));
  }
  
  console.log('');
}

run();
