#!/usr/bin/env node
// Empirical test: does buy_with_affiliation(count, self_address) route the fee back to us?
// Run ONE round-trip on IMAE with 100 tokens, report actual wallet deltas.
import { AeSdk, Node, MemoryAccount, Contract } from '@aeternity/aepp-sdk';
import fs from 'node:fs';
import BigNumber from 'bignumber.js';

const SALE = 'ct_2VRFBXEiwX3SCUpFsWudBCF8pKsjJVnHye3haVZpr28Ku95uvf'; // IMAE
const TOKENS = 100;
const SLIP_PCT = 3;

const node = new Node('https://mainnet.aeternity.io');
const account = new MemoryAccount(process.env.AE_PRIVATE_KEY);
const aeSdk = new AeSdk({ nodes: [{ name: 'mainnet', instance: node }], accounts: [account] });
const self = aeSdk.address;

console.log(`self address: ${self}`);

const saleAci = JSON.parse(fs.readFileSync('./contracts/AffiliationBondingCurveTokenSale.aci.json', 'utf8'));
const sale = await Contract.initialize({ aci: saleAci, address: SALE, onAccount: aeSdk, onNode: aeSdk.api });

const tokenAddr = await sale.token_contract().then(r => r.decodedResult);
const tokenAci = JSON.parse(fs.readFileSync('./contracts/FungibleTokenFull.aci.json', 'utf8'));
const token = await Contract.initialize({ aci: tokenAci, address: tokenAddr, onAccount: aeSdk, onNode: aeSdk.api });
const meta = await token.meta_info().then(r => r.decodedResult);

const tokenDec = new BigNumber(TOKENS).shiftedBy(Number(meta.decimals)).toFixed();

const getBal = async () => new BigNumber(await aeSdk.getBalance(self));
const toAe = (aettos) => new BigNumber(aettos.toString()).dividedBy(1e18);

// 1. Quote
const curveBuy = await sale.price(tokenDec).then(r => r.decodedResult);
const curveSell = await sale.sell_return(tokenDec).then(r => r.decodedResult);
console.log(`\ncurve price for ${TOKENS} tokens:`);
console.log(`  buy side:  ${toAe(curveBuy).toFixed(8)} AE`);
console.log(`  sell side: ${toAe(curveSell).toFixed(8)} AE`);
console.log(`  curve spread: ${toAe(new BigNumber(curveBuy.toString()).minus(curveSell.toString())).toFixed(8)} AE (${new BigNumber(curveBuy.toString()).minus(curveSell.toString()).dividedBy(curveBuy.toString()).times(100).toFixed(3)}%)`);

const priceWithSlip = new BigNumber(curveBuy.toString()).times(1 + SLIP_PCT / 100).toFixed(0);

// 2. Balance before
const b0 = await getBal();
console.log(`\nbalance before: ${b0.dividedBy(1e18).toFixed(6)} AE`);

// 3. buy_with_affiliation(self)
console.log(`\nattempting buy_with_affiliation(${TOKENS}, self)...`);
let buyResult, buyFailed = false;
try {
  buyResult = await sale.buy_with_affiliation(tokenDec, self, { amount: priceWithSlip, omitUnknown: true });
  console.log(`  buy_with_affiliation tx: ${buyResult.hash}`);
} catch (e) {
  buyFailed = true;
  console.error(`  buy_with_affiliation FAILED: ${e.message || e}`);
  console.log(`  falling back to plain buy(${TOKENS}) for baseline measurement`);
  buyResult = await sale.buy(tokenDec, { amount: priceWithSlip, omitUnknown: true });
  console.log(`  plain buy tx: ${buyResult.hash}`);
}

const b1 = await getBal();
const buyCost = b0.minus(b1);
const premiumVsCurve = buyCost.minus(curveBuy.toString());
console.log(`  balance after buy: ${b1.dividedBy(1e18).toFixed(6)} AE`);
console.log(`  actual buy cost: ${buyCost.dividedBy(1e18).toFixed(8)} AE`);
console.log(`  premium over curve: ${premiumVsCurve.dividedBy(1e18).toFixed(8)} AE (${premiumVsCurve.dividedBy(curveBuy.toString()).times(100).toFixed(3)}%)`);

// 4. Allowance + sell
const forAccount = SALE.replaceAll('ct_', 'ak_');
const existing = await token.allowance({ from_account: self, for_account: forAccount }).then(r => r.decodedResult).catch(() => undefined);
if (existing === undefined) {
  await token.create_allowance(forAccount, tokenDec);
  console.log(`  created allowance`);
} else {
  const change = new BigNumber(tokenDec).minus(existing.toString()).toFixed();
  if (change !== '0') {
    await token.change_allowance(forAccount, change);
    console.log(`  adjusted allowance by ${change}`);
  }
}

const minRet = new BigNumber(curveSell.toString()).times(1 - SLIP_PCT / 100).toFixed(0);
console.log(`\nselling ${TOKENS} tokens back...`);
const sellResult = await sale.sell(tokenDec, minRet, { omitUnknown: true });
console.log(`  sell tx: ${sellResult.hash}`);

const b2 = await getBal();
const sellReturn = b2.minus(b1);
const sellDiscountVsCurve = new BigNumber(curveSell.toString()).minus(sellReturn);
console.log(`  balance after sell: ${b2.dividedBy(1e18).toFixed(6)} AE`);
console.log(`  actual sell return: ${sellReturn.dividedBy(1e18).toFixed(8)} AE`);
console.log(`  discount vs curve: ${sellDiscountVsCurve.dividedBy(1e18).toFixed(8)} AE (${sellDiscountVsCurve.dividedBy(curveSell.toString()).times(100).toFixed(3)}%)`);

// 5. Totals
const rtLoss = b0.minus(b2);
const rtLossPct = rtLoss.dividedBy(b0.minus(b1)).times(100);
console.log(`\n=== ROUND-TRIP TOTAL ===`);
console.log(`method: ${buyFailed ? 'plain buy()' : 'buy_with_affiliation(self)'}`);
console.log(`gross loss: ${rtLoss.dividedBy(1e18).toFixed(8)} AE`);
console.log(`as % of capital deployed: ${rtLossPct.toFixed(3)}%`);
console.log(`\ninterpretation:`);
if (buyFailed) {
  console.log('  buy_with_affiliation(self) reverted — self-referral not supported.');
  console.log('  the ~3% buy premium is unrecoverable via this path.');
} else if (premiumVsCurve.dividedBy(curveBuy.toString()).times(100).lt(1)) {
  console.log('  >> BREAKTHROUGH: buy premium is near zero. Affiliation self-referral CAPTURES the fee.');
} else {
  console.log('  buy_with_affiliation executed but premium is still ~3%. Fee routes elsewhere (not to self).');
}
