#!/usr/bin/env node
// Alpha-strategy orchestrator for superhero.com trading.
// Edges exploited: 30-min cycles offset at :07/:37, concentration (2 positions × 30%),
// volume-leading indicator (tx cluster detection), take-profit at +3%, tight stop at -5%,
// post-after-buy amplification via the agent's .chain identity.
// Usage: node orchestrate.mjs [--dry-run] [--no-post]

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const POSITIONS_FILE = path.join(ROOT, 'state/positions.json');
const CYCLES_DIR = path.join(ROOT, 'state/cycles');
const CYCLE_COUNTER_FILE = path.join(ROOT, 'state/cycle-counter.txt');
const LAST_POST_FILE = path.join(ROOT, 'state/last-post-timestamp.txt');

const DRY_RUN = process.argv.includes('--dry-run');
const NO_POST = process.argv.includes('--no-post');

const T = CONFIG.trading;
const P = CONFIG.posting;

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}
function writeJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}
function nowIso() { return new Date().toISOString(); }
function log(...args) {
  console.log(`[${nowIso()}] ${args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}`);
}

function sh(cmd, args, { allowFail = false } = {}) {
  try {
    const out = execFileSync('node', [`scripts/${cmd}.mjs`, ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
      maxBuffer: 10 * 1024 * 1024,
    });
    const trimmed = out.trim();
    try { return JSON.parse(trimmed); } catch {
      const m = trimmed.match(/(\{[\s\S]*\}|\[[\s\S]*\])\s*$/);
      if (m) return JSON.parse(m[1]);
    }
    return { raw: trimmed };
  } catch (e) {
    if (allowFail) return { error: e.message || String(e), stderr: e.stderr?.toString() };
    throw e;
  }
}

function bumpCycle() {
  const n = parseInt(fs.readFileSync(CYCLE_COUNTER_FILE, 'utf8').trim() || '0', 10) + 1;
  fs.writeFileSync(CYCLE_COUNTER_FILE, String(n));
  return n;
}

function fetchRecentBuys(saleAddress, windowMinutes) {
  const txs = sh('superhero-transactions', ['token', saleAddress, '20'], { allowFail: true });
  if (txs.error || !txs.transactions) return 0;
  const cutoff = Date.now() - windowMinutes * 60 * 1000;
  return txs.transactions.filter(t => t.type === 'buy' && new Date(t.timestamp).getTime() >= cutoff).length;
}

function composeBuyPost(symbol, entry) {
  const reasons = [];
  if (entry.volume_buys_recent >= T.volume_signal_min_buys) {
    reasons.push(`${entry.volume_buys_recent} buys in last ${T.volume_signal_window_minutes}min`);
  }
  if (entry.entry_score >= 0.03) reasons.push(`trend ${entry.entry_score.toFixed(3)}`);
  if (entry.holders_count >= 200) reasons.push(`${entry.holders_count} holders`);
  const reason = reasons.length ? reasons.join(', ') : 'momentum scan';
  const chainName = (CONFIG.identity?.chain_name || '').trim();
  const sigil = chainName ? `${chainName} running alpha` : 'autonomous alpha';
  return `opened position in ${symbol} — ${reason}. exit on +${T.take_profit_price_rise_percent}% or -${T.sell_on_price_drop_percent}%. ${sigil} strategy, cycle autonomous.`;
}

function canPostNow() {
  if (!fs.existsSync(LAST_POST_FILE)) return true;
  const last = parseInt(fs.readFileSync(LAST_POST_FILE, 'utf8').trim() || '0', 10);
  const minGapMs = P.min_minutes_between_posts * 60 * 1000;
  return Date.now() - last >= minGapMs;
}
function markPosted() { fs.writeFileSync(LAST_POST_FILE, String(Date.now())); }

async function main() {
  if (!process.env.AE_PRIVATE_KEY) {
    console.error('AE_PRIVATE_KEY not set. Aborting.');
    process.exit(1);
  }

  const cycleNum = DRY_RUN ? -1 : bumpCycle();
  const cycle = {
    cycle: cycleNum,
    timestamp: nowIso(),
    dry_run: DRY_RUN,
    strategy: T.strategy,
    balance_before_ae: null,
    balance_after_ae: null,
    decisions: [],
    trades: [],
    posts: [],
    errors: [],
  };

  // 1. Balance
  const balResp = sh('superhero-wallet', ['balance'], { allowFail: true });
  if (balResp.error) { cycle.errors.push({ step: 'balance', error: balResp.error }); return finish(cycle); }
  cycle.balance_before_ae = Number(balResp.balance_ae);
  log(`cycle #${cycleNum} | balance: ${cycle.balance_before_ae} AE`);

  // 2. Trending
  const trending = sh('superhero-trending', ['tokens', String(T.trending_scan_limit)], { allowFail: true });
  if (!Array.isArray(trending)) { cycle.errors.push({ step: 'trending', error: 'bad shape' }); return finish(cycle); }

  // 3. Holdings
  const holdingsResp = sh('superhero-portfolio', ['holdings'], { allowFail: true });
  const holdings = (holdingsResp.holdings || []).filter(h => Number(h.balance ?? h.amount ?? 0) > 0);

  const state = readJson(POSITIONS_FILE, {});

  // 4. SELL PASS — tight exits (TP / SL / score / max-hold)
  for (const pos of holdings) {
    const sale = pos.sale_address || pos.contract_id || pos.contract;
    const amount = Number(pos.balance ?? pos.amount ?? pos.token_amount ?? 0);
    if (!sale || amount <= 0) continue;

    const stored = state[sale];
    const t = trending.find(x => x.sale_address === sale);
    const currentPrice = Number(t?.price_ae ?? pos.price_ae ?? 0);
    const currentScore = Number(t?.trending_score ?? 0);

    if (!stored) {
      cycle.decisions.push({ sale, symbol: pos.symbol || pos.name, action: 'hold_untracked' });
      continue;
    }

    const priceChangePct = stored.entry_price_ae > 0
      ? ((currentPrice - stored.entry_price_ae) / stored.entry_price_ae) * 100
      : 0;
    const scoreDropPct = stored.entry_score > 0
      ? ((stored.entry_score - currentScore) / stored.entry_score) * 100
      : 0;
    const cyclesHeld = cycleNum - stored.entry_cycle;

    let sellReason = null;
    if (priceChangePct >= T.take_profit_price_rise_percent) sellReason = `take_profit_+${priceChangePct.toFixed(2)}%`;
    else if (priceChangePct <= -T.sell_on_price_drop_percent) sellReason = `stop_loss_${priceChangePct.toFixed(2)}%`;
    else if (scoreDropPct >= T.sell_on_score_drop_percent) sellReason = `score_drop_${scoreDropPct.toFixed(2)}%`;
    else if (cyclesHeld >= T.max_hold_cycles) sellReason = `max_hold_${cyclesHeld}_cycles`;

    const decision = {
      sale, symbol: stored.symbol, amount, action: sellReason ? 'sell' : 'hold',
      reason: sellReason, entry_price: stored.entry_price_ae, current_price: currentPrice,
      price_change_pct: +priceChangePct.toFixed(3), score_drop_pct: +scoreDropPct.toFixed(3), cycles_held: cyclesHeld,
    };
    cycle.decisions.push(decision);

    if (sellReason && !DRY_RUN) {
      log(`  SELL ${amount} ${stored.symbol} — ${sellReason}`);
      const r = sh('superhero-token-swap', ['sell', sale, String(Math.floor(amount))], { allowFail: true });
      if (r.error) cycle.errors.push({ step: 'sell', sale, error: r.error });
      else {
        cycle.trades.push({ action: 'sell', sale, symbol: stored.symbol, amount, tx: r.tx_hash, return_aettos: r.return_aettos, reason: sellReason });
        delete state[sale];
      }
    }
  }

  // 5. BUY PASS — candidate scoring with volume signal
  let liveBalance = cycle.balance_before_ae;
  const filledSlots = Object.keys(state).length;
  const slotsAvailable = Math.max(0, T.max_positions - filledSlots);
  const tradeBudget = liveBalance * T.max_trade_percent_of_balance;

  if (slotsAvailable > 0 && liveBalance > T.min_balance_ae_reserve + tradeBudget) {
    // Score each trending token with volume signal
    const scored = [];
    for (const t of trending) {
      if (state[t.sale_address]) continue;
      if (Number(t.trending_score) < T.min_trending_score) continue;
      if (Number(t.holders_count) < T.min_holders_count) continue;

      const recentBuys = fetchRecentBuys(t.sale_address, T.volume_signal_window_minutes);
      const volumeBoost = recentBuys >= T.volume_signal_min_buys ? T.volume_signal_score_boost : 1;
      const compositeScore = Number(t.trending_score) * volumeBoost;

      scored.push({ ...t, recent_buys: recentBuys, composite_score: compositeScore });
    }
    scored.sort((a, b) => b.composite_score - a.composite_score);
    const candidates = scored.slice(0, slotsAvailable);

    log(`  ${candidates.length} buy candidate(s) of ${scored.length} qualifying (scan=${trending.length})`);

    for (const c of candidates) {
      if (liveBalance < T.min_balance_ae_reserve + tradeBudget) break;

      let tokensToBuy = Math.floor((tradeBudget / Number(c.price_ae)) * 0.90);
      if (tokensToBuy < 1) {
        cycle.decisions.push({ sale: c.sale_address, symbol: c.symbol, action: 'skip_buy', reason: 'budget_too_small' });
        continue;
      }

      const priceCheck = sh('superhero-token-swap', ['price', c.sale_address, String(tokensToBuy)], { allowFail: true });
      if (priceCheck.error) {
        cycle.errors.push({ step: 'price_check', sale: c.sale_address, error: priceCheck.error });
        continue;
      }
      const actualCostAe = Number(priceCheck.price_ae);
      if (actualCostAe > tradeBudget) {
        const ratio = (tradeBudget / actualCostAe) * 0.95;
        tokensToBuy = Math.max(1, Math.floor(tokensToBuy * ratio));
      }

      cycle.decisions.push({
        sale: c.sale_address, symbol: c.symbol, action: 'buy',
        tokens: tokensToBuy, est_cost_ae: actualCostAe, budget_ae: tradeBudget,
        trending_score: Number(c.trending_score), recent_buys: c.recent_buys,
        composite_score: c.composite_score, holders: c.holders_count,
      });

      if (!DRY_RUN) {
        log(`  BUY ${tokensToBuy} ${c.symbol} (~${actualCostAe.toFixed(4)} AE, volume=${c.recent_buys})`);
        const r = sh('superhero-token-swap', ['buy', c.sale_address, String(tokensToBuy)], { allowFail: true });
        if (r.error) {
          cycle.errors.push({ step: 'buy', sale: c.sale_address, error: r.error });
        } else {
          const entry = {
            symbol: c.symbol,
            sale_address: c.sale_address,
            entry_price_ae: Number(c.price_ae),
            entry_score: Number(c.trending_score),
            entry_time: nowIso(),
            entry_cycle: cycleNum,
            amount: tokensToBuy,
            volume_buys_recent: c.recent_buys,
            holders_count: c.holders_count,
          };
          state[c.sale_address] = entry;
          cycle.trades.push({ action: 'buy', sale: c.sale_address, symbol: c.symbol, amount: tokensToBuy, tx: r.tx_hash, cost_aettos: r.price_aettos });
          liveBalance -= actualCostAe;

          // Post-after-buy amplification
          if (!NO_POST && P.enabled && P.post_after_buy && canPostNow()) {
            const msg = composeBuyPost(c.symbol, entry);
            const postResult = sh('superhero-post', [msg.slice(0, 280)], { allowFail: true });
            if (postResult.error) cycle.errors.push({ step: 'post', error: postResult.error });
            else {
              cycle.posts.push({ tx: postResult.tx_hash, post_id: postResult.post_id, content: msg });
              markPosted();
            }
          }
        }
      }
    }
  } else {
    cycle.decisions.push({ action: 'no_buys', reason: `slots=${slotsAvailable} balance=${liveBalance.toFixed(2)}` });
  }

  if (!DRY_RUN) writeJson(POSITIONS_FILE, state);

  const balAfter = sh('superhero-wallet', ['balance'], { allowFail: true });
  cycle.balance_after_ae = balAfter.error ? null : Number(balAfter.balance_ae);

  finish(cycle);
}

function finish(cycle) {
  const fname = DRY_RUN
    ? 'dry-run-latest.json'
    : `cycle-${String(cycle.cycle).padStart(5, '0')}-${cycle.timestamp.replace(/[:.]/g, '-')}.json`;
  writeJson(path.join(CYCLES_DIR, fname), cycle);
  log(`cycle #${cycle.cycle} done | trades=${cycle.trades.length} posts=${cycle.posts.length} errors=${cycle.errors.length} | balance ${cycle.balance_before_ae} → ${cycle.balance_after_ae}`);
  if (cycle.errors.length) console.error(JSON.stringify(cycle.errors, null, 2));
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
