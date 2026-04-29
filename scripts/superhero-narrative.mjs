#!/usr/bin/env node
// Narrative-trading helper: read what other event agents are saying, find
// untokenized hashtags worth launching, and feed Claude the data needed
// to make sentiment-driven buy/sell/comment/tokenize decisions.
//
// Read-only — never sends a transaction. Composing posts/comments and
// firing trades stay in the dedicated scripts (superhero-post,
// superhero-comment, superhero-token-swap, superhero-token-create).
//
// Usage:
//   feed [limit=30]
//     Recent platform posts (everyone). Returns content, sender,
//     token_mentions, total_comments, post_id (for commenting).
//
//   agents [limit=50]
//     Recent posts authored by event participants (filtered against the
//     leaderboard's registered list). Defaults to non-self.
//
//   mentions [limit=50]
//     Aggregated token-mention frequency across recent posts.
//     Tells you which tokens the room is talking about.
//
//   untokenized [limit=20]
//     X-trending hashtags that don't yet have a token on superhero.com.
//     First-mover opportunity (factory rebate via create_community).
//
//   token-info <symbol>
//     Resolve a hashtag/symbol to its sale_address + current price.
//     Use this before deciding whether to buy/sell.

import { MemoryAccount } from '@aeternity/aepp-sdk';

const API_URL = 'https://api.superhero.com';
const LEADERBOARD_URL =
  process.env.VCN_LEADERBOARD_URL ||
  'https://configuring-mozilla-cooperation-diesel.trycloudflare.com';

function ownAk() {
  const sk = process.env.AE_PRIVATE_KEY;
  if (!sk) return null;
  return new MemoryAccount(sk).address;
}

async function fetchJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
  return r.json();
}

// ── feed ────────────────────────────────────────────────────────────────
async function feed(limit) {
  const lim = parseInt(limit) || 30;
  const data = await fetchJSON(`${API_URL}/api/posts?limit=${lim}&order_by=created_at&order_direction=DESC`);
  const items = (data.items || []).map(p => ({
    id: p.id,
    parent_id: p.post_id || null,
    kind: p.post_id ? 'comment' : 'post',
    sender: p.sender_address,
    sender_chain: p.sender?.public_name || null,
    content: p.content || '',
    token_mentions: p.token_mentions || [],
    total_comments: p.total_comments || 0,
    created_at: p.created_at,
  }));
  console.log(JSON.stringify(items, null, 2));
}

// ── agents ──────────────────────────────────────────────────────────────
async function agents(limit) {
  const lim = parseInt(limit) || 50;
  const me = ownAk();

  // Get the current participant list from the leaderboard
  let participants = [];
  try {
    const lb = await fetchJSON(`${LEADERBOARD_URL}/state.json`);
    participants = (lb.registered || []).map(r => ({
      ak: r.ak,
      chain_name: r.chain_name,
      name: r.name,
    }));
  } catch (e) {
    console.error(`(could not reach leaderboard at ${LEADERBOARD_URL}: ${e.message})`);
  }

  if (!participants.length) {
    console.log(JSON.stringify({
      participants_known: 0,
      note: 'no participants registered on the leaderboard yet',
      posts: [],
    }, null, 2));
    return;
  }

  const akSet = new Set(participants.filter(p => p.ak !== me).map(p => p.ak));
  const akToParticipant = new Map(participants.map(p => [p.ak, p]));

  // Pull a generous batch and filter
  const data = await fetchJSON(`${API_URL}/api/posts?limit=${Math.max(lim * 4, 100)}&order_by=created_at&order_direction=DESC`);
  const items = (data.items || [])
    .filter(p => akSet.has(p.sender_address))
    .slice(0, lim)
    .map(p => {
      const meta = akToParticipant.get(p.sender_address) || {};
      return {
        id: p.id,
        parent_id: p.post_id || null,
        kind: p.post_id ? 'comment' : 'post',
        author_chain: meta.chain_name,
        author_name: meta.name,
        author_ak: p.sender_address,
        content: p.content || '',
        token_mentions: p.token_mentions || [],
        total_comments: p.total_comments || 0,
        created_at: p.created_at,
      };
    });

  console.log(JSON.stringify({
    you: me ? me.slice(0, 12) + '…' : null,
    participants_known: participants.length,
    other_agents: akSet.size,
    posts: items,
  }, null, 2));
}

// ── mentions ────────────────────────────────────────────────────────────
async function mentions(limit) {
  const lim = parseInt(limit) || 50;
  const data = await fetchJSON(`${API_URL}/api/posts?limit=${lim}&order_by=created_at&order_direction=DESC`);
  const counts = new Map();
  for (const p of data.items || []) {
    for (const t of p.token_mentions || []) {
      const cur = counts.get(t) || { token: t, count: 0, posts: [] };
      cur.count += 1;
      cur.posts.push({ id: p.id, sender: p.sender_address, content: (p.content || '').slice(0, 100) });
      counts.set(t, cur);
    }
  }
  const sorted = [...counts.values()].sort((a, b) => b.count - a.count);
  console.log(JSON.stringify(sorted, null, 2));
}

// ── untokenized ─────────────────────────────────────────────────────────
async function untokenized(limit) {
  const lim = parseInt(limit) || 20;
  const data = await fetchJSON(`${API_URL}/api/trending-tags?limit=${lim}`);
  const items = (data.items || []).map(t => ({
    tag: t.tag,
    score: t.score,
    source: t.source,
    has_token: !!t.token,
    sale_address: t.token?.sale_address || null,
  }));
  const open = items.filter(i => !i.has_token);
  console.log(JSON.stringify({
    note: 'Untokenized X-trending hashtags. First mover via CommunityFactory.create_community gets the affiliation rebate (1%) on the initial buy.',
    total_trending: items.length,
    untokenized_count: open.length,
    untokenized: open,
    already_tokenized: items.filter(i => i.has_token),
  }, null, 2));
}

// ── discover ────────────────────────────────────────────────────────────
// Cross-reference hashtags being mentioned by event participants against the
// token registry. Returns: hashtags that 2+ agents are talking about but
// nobody has tokenized yet — first-mover opportunities.
async function discover() {
  // Participants from leaderboard
  let participants = [];
  try {
    const lb = await fetchJSON(`${LEADERBOARD_URL}/state.json`);
    participants = (lb.registered || []).map(r => ({ ak: r.ak, chain_name: r.chain_name, name: r.name }));
  } catch (e) {
    console.error(`(could not reach leaderboard: ${e.message})`);
  }
  const akSet = new Set(participants.map(p => p.ak));

  // Recent platform posts → filter to participants
  const posts = await fetchJSON(`${API_URL}/api/posts?limit=200&order_by=created_at&order_direction=DESC`);
  const ourPosts = (posts.items || []).filter(p => akSet.has(p.sender_address));

  // Aggregate hashtag mentions by upper-cased symbol
  const counts = new Map();
  for (const p of ourPosts) {
    const seenInThisPost = new Set();
    for (const t of p.token_mentions || []) {
      const sym = t.toUpperCase();
      if (seenInThisPost.has(sym)) continue;
      seenInThisPost.add(sym);
      const cur = counts.get(sym) || { tag: sym, count: 0, posts: [], senders: new Set() };
      cur.count += 1;
      cur.senders.add(p.sender_address);
      cur.posts.push({
        id: p.id,
        sender: p.sender_address,
        sender_chain: p.sender?.public_name || null,
        content: (p.content || '').slice(0, 140),
        created_at: p.created_at,
      });
      counts.set(sym, cur);
    }
  }

  // Pull all known token symbols (generous batch)
  const tokens = await fetchJSON(`${API_URL}/api/tokens?limit=500&order_by=created_at&order_direction=DESC`);
  const knownByUpper = new Map(
    (tokens.items || []).map(t => [(t.symbol || '').toUpperCase(), t])
  );

  // Split into untokenized opportunities vs already-tokenized
  const opportunities = [];
  const existing = [];
  for (const c of counts.values()) {
    const distinct_senders = c.senders.size;
    if (c.count < 2 && distinct_senders < 2) continue;  // need real signal
    const tok = knownByUpper.get(c.tag);
    const entry = {
      tag: c.tag,
      mention_count: c.count,
      distinct_senders,
      posts: c.posts,
    };
    if (tok) {
      existing.push({
        ...entry,
        has_token: true,
        sale_address: tok.sale_address,
        holders_count: tok.holders_count,
        price_ae: tok.price,
        sell_price_ae: tok.sell_price,
      });
    } else {
      opportunities.push({ ...entry, has_token: false });
    }
  }
  opportunities.sort((a, b) => b.distinct_senders - a.distinct_senders || b.mention_count - a.mention_count);
  existing.sort((a, b) => b.distinct_senders - a.distinct_senders || b.mention_count - a.mention_count);

  console.log(JSON.stringify({
    note: 'Hashtags appearing in 2+ event-agent posts. UNTOKENIZED ones are first-mover opportunities — call superhero-token-create.mjs create <TAG> <buy_ae> to capture the affiliation rebate and own the curve.',
    participants_known: participants.length,
    posts_scanned: ourPosts.length,
    untokenized_opportunities: opportunities,
    already_tokenized: existing,
  }, null, 2));
}

// ── token-info ──────────────────────────────────────────────────────────
async function tokenInfo(symbol) {
  if (!symbol) {
    console.error('Usage: token-info <symbol>');
    process.exit(1);
  }
  // Search by name match in trending list
  const data = await fetchJSON(`${API_URL}/api/tokens?order_by=trending_score&order_direction=DESC&limit=200`);
  const match = (data.items || []).find(t =>
    (t.symbol || '').toLowerCase() === symbol.toLowerCase() ||
    (t.name || '').toLowerCase() === symbol.toLowerCase()
  );
  if (!match) {
    console.log(JSON.stringify({ symbol, found: false, note: 'Not in top-200 by trending score. May still exist.' }));
    return;
  }
  console.log(JSON.stringify({
    symbol: match.symbol,
    name: match.name,
    sale_address: match.sale_address,
    price_ae: match.price,
    sell_price_ae: match.sell_price,
    holders_count: match.holders_count,
    market_cap_ae: match.market_cap,
    trending_score: match.trending_score,
    created_at: match.created_at,
    found: true,
  }, null, 2));
}

async function main() {
  const cmd = process.argv[2] || 'help';
  const arg1 = process.argv[3];

  switch (cmd) {
    case 'feed':
      await feed(arg1);
      break;
    case 'agents':
      await agents(arg1);
      break;
    case 'mentions':
      await mentions(arg1);
      break;
    case 'untokenized':
      await untokenized(arg1);
      break;
    case 'discover':
      await discover();
      break;
    case 'token-info':
      await tokenInfo(arg1);
      break;
    case 'help':
    default:
      console.log(`
Narrative-trading helpers:

  feed [limit]            Recent platform posts (everyone)
  agents [limit]          Recent posts FROM event participants (excludes you)
  mentions [limit]        Token-mention frequency in recent posts
  discover                Hashtags appearing in 2+ AGENT posts that aren't
                          tokenized yet — race-to-first-mover opportunities
  untokenized [limit]     X-trending hashtags with no token (broader scope)
  token-info <symbol>     Resolve a hashtag/symbol to sale_address + price

How to use this in the cycle:

  1. Read agents — what are other bots saying?
     node scripts/superhero-narrative.mjs agents 30

  2. Read mentions — which tokens are getting talked about?
     node scripts/superhero-narrative.mjs mentions 50

  3. For each interesting post, decide: buy/sell/comment.
     - Use superhero-token-info OR token-info <symbol> to get sale_address
     - Use superhero-token-swap.mjs buy/sell <sale_address> <amount>
     - Use superhero-comment.mjs post <post_id> "<your reaction>"

  4. Look for first-mover hashtag opportunities:
     node scripts/superhero-narrative.mjs untokenized
     - Pick one matching your persona, then:
       node scripts/superhero-token-create.mjs create <SYMBOL> <ae_to_buy>

Read-only — never sends transactions. Pair with the action scripts.
`);
  }
}

main().catch(e => { console.error('ERROR:', e.message || e); process.exit(1); });
