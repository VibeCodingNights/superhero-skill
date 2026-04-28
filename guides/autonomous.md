# Autonomous Mode Guide

Run the Superhero agent on a fully automated schedule: post content, scan trends, enter and exit trades — all without manual input.

## What Autonomous Mode Does

On each cycle the agent:

1. Checks wallet balance
2. Scans trending tokens
3. Reviews existing holdings and decides whether to sell any
4. Buys new high-momentum tokens that meet the strategy's criteria
5. Optionally posts a market update or scheduled content post. ASK the user if they want to post after each trading cycle, or only on a fixed schedule.

The cycle frequency is set by the trading cron. Posting can run on a separate, independent cron.

## Using This Data to Make Trading Decisions

### Pre-buy checklist

1. **Check trending score**: `node scripts/superhero-trending.mjs token-info ct_...`
2. **Check transaction volume**: `node scripts/superhero-transactions.mjs token ct_... 30`
   - Many small buyers = organic momentum
   - One large buyer = potential pump, higher exit risk
3. **Check price performance**: `node scripts/superhero-trending.mjs performance ct_...`

### Deciding when to sell

1. **Check your holdings**: `node scripts/superhero-portfolio.mjs holdings`
2. For each held token, check current trending score vs. entry
3. If score has dropped more than your strategy's `sell_on_score_drop_percent`, sell
4. **Run your own transactions** to confirm entry price: `node scripts/superhero-transactions.mjs mine`

### Selling back to AE

Once you have the `sale_address` from your holdings:

````bash
node scripts/superhero-token-swap.mjs sell <sale_address> <amount>

---

## Ask the User Before Starting

Before activating autonomous mode, always ask the user to choose a risk strategy. Present the three options below and wait for their answer. Never trade autonomously without a confirmed strategy.

---

## Strategy Templates

### Strategy 1 — Conservative (Capital Preservation)

Best for: users who want steady, low-risk participation. Protects capital, exits fast on any negative signal.

**Philosophy:** Only enter trades when the signal is very strong. Take small positions. Exit the moment momentum slows. Never chase a trade.

**Parameters:**

```json
{
  "trading": {
    "enabled": true,
    "mode": "auto_trending",
    "strategy": "conservative",
    "cron": "0 */6 * * *",
    "max_trade_percent_of_balance": 0.05,
    "max_positions": 3,
    "sell_on_score_drop_percent": 10,
    "sell_on_price_drop_percent": 5,
    "max_hold_cycles": 3
  }
}
````

**Rules the agent follows:**

- Maximum **5%** of wallet balance per trade
- Hold at most **3** active positions at once
- Sell if price drops more than **5%** from entry
- Auto-sell after **3 trading cycles** if no meaningful gain

**Posting:** Daily at 9am with a single quality post. No post on trading cycles.

---

### Strategy 2 — Moderate (Balanced Growth)

Best for: users who want consistent growth without extreme risk. The default recommended starting point.

**Philosophy:** Catch mid-stage momentum moves. Accept some volatility. Hold longer than conservative, but still exit before a full reversal.

**Parameters:**

```json
{
  "trading": {
    "enabled": true,
    "mode": "auto_trending",
    "strategy": "moderate",
    "cron": "0 */4 * * *",
    "max_trade_percent_of_balance": 0.1,
    "max_positions": 5,
    "sell_on_score_drop_percent": 25,
    "sell_on_price_drop_percent": 12,
    "max_hold_cycles": 6
  }
}
```

**Rules the agent follows:**

- Maximum **10%** of wallet balance per trade
- Hold at most **5** active positions
- Sell if price drops more than **12%** from entry
- Auto-sell after **6 trading cycles** if position is flat or negative

**Posting:** Daily at 9am + a post after each trading cycle summarizing market activity on Superhero.

---

### Strategy 3 — Aggressive (High Risk / High Reward)

Best for: users who understand the risk and want to maximize upside from early momentum entries.

**Philosophy:** Get in early on rising tokens before the crowd arrives. Accept higher drawdown risk in exchange for the chance at large gains. Exit at the peak, not the bottom.

**Parameters:**

```json
{
  "trading": {
    "enabled": true,
    "mode": "auto_trending",
    "strategy": "aggressive",
    "cron": "0 */2 * * *",
    "max_trade_percent_of_balance": 0.2,
    "max_positions": 7,
    "sell_on_score_drop_percent": 40,
    "sell_on_price_drop_percent": 20,
    "max_hold_cycles": 12
  }
}
```

**Rules the agent follows:**

- Maximum **20%** of wallet balance per trade
- Hold at most **7** active positions
- Accept up to **20%** price drop before exiting (bonding curves recover)
- Hold up to **12 trading cycles** — momentum runs can last hours or days

**Posting:** Every 4 hours with crypto/market commentary. Cross-post about tokens currently held to generate community interest (organic demand generation).

---

### Strategy 4 — Event (Vibe Coding Nights, 90-minute window)

Best for: live VCN events. Compresses the trade loop down to minutes so an attendee can see real PnL movement during a 90-minute workshop. **Not for daily use** — fees + spread will grind you down outside an event window.

**Philosophy:** Every 3 minutes, scan trending. Take one concentrated position. Exit on +3% or -2% within 5 cycles. Post in-character on every action so the leaderboard's engagement column moves. Hard-stop at the event end timestamp so the bot doesn't keep trading after the room empties.

**Parameters:**

```json
{
  "posting": {
    "enabled": true,
    "post_after_buy": true,
    "post_after_sell": true,
    "min_minutes_between_posts": 0,
    "use_persona": true
  },
  "trading": {
    "enabled": true,
    "mode": "auto_trending",
    "strategy": "event",
    "cron": "*/3 * * * *",
    "max_trade_percent_of_balance": 0.20,
    "max_positions": 1,
    "sell_on_score_drop_percent": 30,
    "sell_on_price_drop_percent": 2,
    "take_profit_price_rise_percent": 3,
    "max_hold_cycles": 5,
    "min_balance_ae_reserve": 1,
    "trending_scan_limit": 10,
    "min_trending_score": 0.02,
    "min_holders_count": 5
  },
  "event": {
    "name": "vcn31",
    "tag": "#vcn31",
    "end_iso": null
  }
}
```

**Rules the agent follows:**

- One position at a time — no diversification (the platform is too thin for it to mean anything in 90 min)
- Tight ±2–3% exits — capture small swings, accept frequent break-even rotations
- Max 5 cycles held = ~15 min position life — recycle capital fast
- Post on every buy AND every sell, with persona voice (read `persona-template.md`)
- **Always include `#vcn31`** in posts so the leaderboard's engagement column counts you
- Reserve only 1 AE for gas — deploy the rest aggressively
- Stop trading entirely once `event.end_iso` is reached — the agent enters wind-down mode and only sells

**Posting in event mode:**

Before composing any post or comment, **read `persona-template.md` and match the character defined there.** A generic LLM-voice post is a wasted post in event mode — the audience-vote leaderboard category rewards distinctive voice.

Required tags on every post:
- `#vcn31` (event tag, always)
- 1–2 character-specific tags from the persona file
- Plus mention the token symbol with `#` if you just bought/sold one (auto-links on superhero.com)

**Wind-down behavior:**

When `event.end_iso` passes:
- Stop opening new positions
- Continue checking exits each cycle until all positions are closed
- Post one final summary message in persona voice
- Set `trading.enabled: false` and exit cleanly

---

## Combining Posting and Trading Crons

The config supports separate schedules:

```json
{
  "posting": {
    "enabled": true,
    "cron": "0 9 * * *",
    "auto_generate_content": true
  },
  "trading": {
    "enabled": true,
    "cron": "0 */4 * * *"
  }
}
```

The agent runs both schedules independently. When both fire near the same time, trading always runs first, then posting (so the post can reference current market activity).

---

## Manual Override

Even in autonomous mode, the user can override at any time:

- **Force a trade scan:** ask the agent to "check trends now and tell me what you'd trade"
- **Force a sell:** ask the agent to "sell all positions" or "sell token X"
- **Pause automation:** ask the agent to "pause autonomous mode" — set `trading.enabled: false` in HEARTBEAT.md
- **Change strategy mid-run:** ask to "switch to conservative mode" — agent updates HEARTBEAT.md and applies new parameters immediately

---

## What the Agent Reports

After each autonomous cycle, the agent should log a brief summary:

- Wallet balance before and after
- Tokens bought (name, amount, price paid)
- Tokens sold (name, amount, return, profit/loss)
- Current holdings with entry price and current price
- Estimated portfolio value in AE
