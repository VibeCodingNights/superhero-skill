#!/usr/bin/env node
// Register on the live VCN event leaderboard via the public API.
// No UI step — calls /api/register directly. The leaderboard validates that the
// .chain name actually points at the AE_PRIVATE_KEY wallet on-chain.
//
// Usage:
//   node scripts/superhero-leaderboard.mjs register [chain_name] [display_name]
//   node scripts/superhero-leaderboard.mjs status
//
// chain_name is optional — falls back to config.json's identity.chain_name.

import { MemoryAccount } from '@aeternity/aepp-sdk';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// Default points at the live VCN #31 tunnel. Override with env if it rotates.
const LEADERBOARD_URL =
  process.env.VCN_LEADERBOARD_URL ||
  'https://appointments-cute-minolta-textbooks.trycloudflare.com';

function getWalletAddress() {
  const sk = process.env.AE_PRIVATE_KEY;
  if (!sk) {
    console.error('AE_PRIVATE_KEY environment variable is not set.');
    process.exit(1);
  }
  return new MemoryAccount(sk).address;
}

function readChainNameFromConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
    return (cfg.identity?.chain_name || '').trim() || null;
  } catch {
    return null;
  }
}

async function register(chainNameArg, displayName) {
  const ak = getWalletAddress();
  const chain_name = (chainNameArg || readChainNameFromConfig() || '').trim();

  if (!chain_name) {
    console.error(JSON.stringify({
      success: false,
      error: 'no chain_name provided and config.json has no identity.chain_name',
      hint: 'Run "node scripts/superhero-name.mjs register <name>" first, then pass it: register <name>',
    }));
    process.exit(1);
  }

  const body = { ak, chain_name };
  if (displayName) body.name = displayName;

  console.error(`Registering ${chain_name} (${ak.slice(0, 10)}…) on the VCN leaderboard...`);

  const res = await fetch(`${LEADERBOARD_URL}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    console.log(JSON.stringify({
      success: false,
      status: res.status,
      error: data.error || 'register failed',
      hint: res.status === 400 && /not registered on-chain/i.test(data.error || '')
        ? 'The .chain name is not on-chain yet. Run superhero-name.mjs register <name> first.'
        : res.status === 400 && /points to a different wallet/i.test(data.error || '')
          ? 'The .chain name belongs to a different wallet. Use the wallet that owns it.'
          : res.status === 409
            ? 'Already registered or event is closed for new registrations.'
            : null,
    }));
    process.exit(1);
  }

  console.log(JSON.stringify({
    success: true,
    chain_name: data.chain_name,
    ak: data.ak,
    initial_balance_ae: data.initial_balance_ae,
    total_registered: data.count,
    next_steps: [
      'Open https://vibecodingnights.com/superhero on the projection screen',
      'Configure the "event" strategy and persona, then start the autonomous loop',
    ],
  }, null, 2));
}

async function status() {
  const res = await fetch(`${LEADERBOARD_URL}/state.json`);
  const data = await res.json();

  console.log(JSON.stringify({
    event_status: data.event_status,
    t0_iso: data.t0_iso,
    end_iso: data.end_iso,
    registered_count: (data.registered || []).length,
    registered: (data.registered || []).map(r => ({
      ak: r.ak.slice(0, 10) + '…',
      chain_name: r.chain_name,
      name: r.name,
    })),
    last_update: data.lastUpdate,
  }, null, 2));
}

async function main() {
  const cmd = process.argv[2] || 'help';
  const arg1 = process.argv[3];
  const arg2 = process.argv[4];

  switch (cmd) {
    case 'register':
      await register(arg1, arg2);
      break;
    case 'status':
      await status();
      break;
    case 'help':
    default:
      console.log(`
VCN Leaderboard Commands:

  register [chain_name] [display_name]
    Register the current wallet (AE_PRIVATE_KEY) on the live event leaderboard.
    chain_name is optional — falls back to config.json identity.chain_name.
    The leaderboard validates ownership on-chain before accepting.

  status
    Show current event status + registered list (no auth needed).

Environment:
  AE_PRIVATE_KEY        required for register
  VCN_LEADERBOARD_URL   override the default leaderboard URL (rare)

Examples:
  node scripts/superhero-leaderboard.mjs register
  node scripts/superhero-leaderboard.mjs register myagent.chain
  node scripts/superhero-leaderboard.mjs register myagent.chain "@myhandle"
  node scripts/superhero-leaderboard.mjs status
`);
  }
}

main().catch(e => {
  console.error('ERROR:', e.message || e);
  process.exit(1);
});
