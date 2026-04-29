#!/usr/bin/env node
// Wallet management for superhero.com / æternity blockchain
// Generate new wallet, check balance, export address, render fund-me QR
import { AeSdk, Node, MemoryAccount } from '@aeternity/aepp-sdk';
import qrcodeTerminal from 'qrcode-terminal';
import QRCode from 'qrcode';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';

const NODE_URL = 'https://mainnet.aeternity.io';

function loadAccount() {
  const privateKey = process.env.AE_PRIVATE_KEY;
  if (!privateKey) {
    console.error('AE_PRIVATE_KEY environment variable is not set.');
    console.error('Set it with: export AE_PRIVATE_KEY=<your_secret_key>');
    process.exit(1);
  }
  return new MemoryAccount(privateKey);
}

function generateWallet() {
  const account = MemoryAccount.generate();
  console.log(JSON.stringify({
    success: true,
    address: account.address,
    AE_PRIVATE_KEY: account.secretKey,
    next_step: `export AE_PRIVATE_KEY=${account.secretKey}`,
    warning: 'Save this private key securely. Back it up offline. Never commit it to git.',
  }));
}

async function getBalance() {
  const account = loadAccount();
  const node = new Node(NODE_URL);
  const sdk = new AeSdk({
    nodes: [{ name: 'mainnet', instance: node }],
  });
  try {
    const balanceAettos = await sdk.getBalance(account.address);
    const balanceAE = parseInt(balanceAettos) / 1e18;
    console.log(JSON.stringify({
      address: account.address,
      balance_ae: balanceAE,
      balance_aettos: balanceAettos,
    }));
  } catch (e) {
    console.log(JSON.stringify({ address: account.address, balance_ae: 0, balance_aettos: '0' }));
  }
}

function showAddress() {
  const account = loadAccount();
  console.log(JSON.stringify({ address: account.address }));
}

function importWallet(secretKey) {
  if (!secretKey) {
    console.error('Usage: node scripts/superhero-wallet.mjs import <secretKey>');
    process.exit(1);
  }
  const account = new MemoryAccount(secretKey);
  console.log(JSON.stringify({
    success: true,
    address: account.address,
    next_step: `export AE_PRIVATE_KEY=${secretKey}`,
    warning: 'Save this private key securely. Back it up offline. Never commit it to git.',
  }));
}

async function showFundQr(address) {
  const target = address || (process.env.AE_PRIVATE_KEY ? new MemoryAccount(process.env.AE_PRIVATE_KEY).address : null);
  if (!target) {
    console.error('Usage: node scripts/superhero-wallet.mjs qr [ak_address]');
    console.error('  (or set AE_PRIVATE_KEY env var to use your own wallet)');
    process.exit(1);
  }

  // Stderr for the human-friendly text — keeps stdout clean if anyone parses it.
  console.error(`\nFund me: ${target}\n`);
  console.error("Scan this with the host's wallet app to send AE.");
  console.error('After they send, run "node scripts/superhero-wallet.mjs balance" to confirm.\n');

  // 1. Terminal QR (works in any shell, no GUI needed)
  await new Promise((resolve) => {
    qrcodeTerminal.generate(target, { small: true }, (qr) => {
      process.stderr.write(qr + '\n');
      resolve();
    });
  });

  // 2. Big PNG saved to a temp file, auto-opened on desktop
  const pngPath = path.join(os.tmpdir(), `vcn-fundme-${target.slice(3, 11)}.png`);
  let pngOpened = false;
  try {
    await QRCode.toFile(pngPath, target, {
      width: 600,
      margin: 3,
      color: { dark: '#000000', light: '#ffffff' },
    });
    const opener =
      process.platform === 'darwin' ? 'open' :
      process.platform === 'win32' ? 'start' :
      'xdg-open';
    const child = spawn(opener, [pngPath], {
      detached: true,
      stdio: 'ignore',
      ...(process.platform === 'win32' ? { shell: true } : {}),
    });
    child.unref();
    pngOpened = true;
    console.error(`(opened ${pngPath} for the host to scan)\n`);
  } catch (e) {
    console.error(`(could not auto-open PNG: ${e.message} — terminal QR above still works)\n`);
  }

  // stdout: structured for any script consumer
  console.log(JSON.stringify({
    address: target,
    png_path: pngOpened ? pngPath : null,
  }));
}

async function main() {
  const command = process.argv[2] || 'help';
  const arg = process.argv[3];

  switch (command) {
    case 'generate':
      generateWallet();
      break;
    case 'balance':
      await getBalance();
      break;
    case 'address':
      showAddress();
      break;
    case 'import':
      importWallet(arg);
      break;
    case 'qr':
      showFundQr(arg);
      break;
    case 'exists':
      console.log(JSON.stringify({ exists: !!process.env.AE_PRIVATE_KEY }));
      break;
    case 'help':
    default:
      console.log(`
Wallet Commands:
  generate              Create a new wallet keypair (outputs key once — save it)
  import <secretKey>    Show setup instructions for an existing secret key
  balance               Check wallet AE balance  (requires AE_PRIVATE_KEY env var)
  address               Show wallet address      (requires AE_PRIVATE_KEY env var)
  qr [ak_address]       Print a terminal QR code so a host can scan + send AE
                        (uses AE_PRIVATE_KEY's wallet by default, or pass an ak_…)
  exists                Check if AE_PRIVATE_KEY env var is set

Environment:
  export AE_PRIVATE_KEY=<your_secret_key>
`);
  }
}

main().catch(e => { console.error('ERROR:', e.message || e); process.exit(1); });
