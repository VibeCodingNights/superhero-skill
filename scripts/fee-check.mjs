#!/usr/bin/env node
// Quick probe: read fee percentage + simulate a small round-trip on a sale contract.
// Usage: node scripts/fee-check.mjs <sale_address>
import { AeSdk, Node, MemoryAccount, Contract, formatAmount, AE_AMOUNT_FORMATS } from '@aeternity/aepp-sdk';
import fs from 'node:fs';
import BigNumber from 'bignumber.js';

const NODE_URL = 'https://mainnet.aeternity.io';
const sale = process.argv[2];
if (!sale) { console.error('usage: fee-check.mjs <sale_address>'); process.exit(1); }

const aci = JSON.parse(fs.readFileSync('./contracts/AffiliationBondingCurveTokenSale.aci.json', 'utf8'));
const node = new Node(NODE_URL);
const account = new MemoryAccount(process.env.AE_PRIVATE_KEY);
const aeSdk = new AeSdk({ nodes: [{ name: 'mainnet', instance: node }], accounts: [account] });
const c = await Contract.initialize({ aci, address: sale, onAccount: aeSdk, onNode: aeSdk.api });

// Get token decimals
const tokenContract = await Contract.initialize({
  aci: JSON.parse(fs.readFileSync('./contracts/FungibleTokenFull.aci.json', 'utf8')),
  address: await c.token_contract().then(r => r.decodedResult),
  onAccount: aeSdk, onNode: aeSdk.api
});
const meta = await tokenContract.meta_info().then(r => r.decodedResult);

// Simulate: price to buy 100 tokens, then immediate sell_return for same
const amt = new BigNumber('100').shiftedBy(Number(meta.decimals)).toFixed();
const [buyPrice, sellReturn] = await Promise.all([
  c.price(amt).then(r => r.decodedResult),
  c.sell_return(amt).then(r => r.decodedResult),
]);

const buyAE  = new BigNumber(buyPrice.toString()).dividedBy(1e18);
const sellAE = new BigNumber(sellReturn.toString()).dividedBy(1e18);
const spread = buyAE.minus(sellAE);
const spreadPct = spread.dividedBy(buyAE).times(100);

// Apply 3% slippage on buy + 3% on sell (worst-case)
const buyWithSlip  = buyAE.times(1.03);
const sellWithSlip = sellAE.times(0.97);
const wcSpread = buyWithSlip.minus(sellWithSlip);
const wcSpreadPct = wcSpread.dividedBy(buyWithSlip).times(100);

console.log(JSON.stringify({
  sale,
  sample_amount_tokens: 100,
  zero_slippage_buy_ae: buyAE.toFixed(6),
  zero_slippage_sell_return_ae: sellAE.toFixed(6),
  curve_spread_ae: spread.toFixed(6),
  curve_spread_pct: spreadPct.toFixed(3),
  worst_case_round_trip_loss_ae: wcSpread.toFixed(6),
  worst_case_round_trip_loss_pct: wcSpreadPct.toFixed(3),
}, null, 2));
