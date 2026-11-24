// Pump.fun Replay Sprint — paper bot (agent-fun/replay/v2).
//
// Strategy: early-momentum trend following on bonding-curve prices.
//
// The harness speaks newline-delimited JSON on stdin: one `hello`, then one
// `batch` per slot (with that slot's TradeEvent / CreateEvent / CompleteEvent
// records, marks, fills and the account), then `done`. The bot answers every
// batch with exactly one `reply` echoing its seq and carrying its orders.
// Everything here is deterministic: no clock, no environment, no unseeded
// randomness, so the two grading executions produce byte-identical logs.
//
// Price of a coin is its bonding-curve quote per token, from the virtual
// reserves: price = virtual_quote_reserves / virtual_token_reserves, kept as
// a fixed-point bigint (SCALE = 1e12) so no float ever decides a trade.
//
// Entry: a coin becomes a candidate at its CreateEvent. On every trade we
// update a fast and a slow exponential moving average of its price, and keep
// its last 10 trades. We buy when the fast EMA has crossed clearly above the
// slow EMA *and* the price is already up at least 5% from its creation price
// (real buying pressure, not a dead curve) but not more than 5x (no chasing
// the top), *and* the last 10 trades are buy-dominated (buy SOL at least
// 1.5x sell SOL: the rise is backed by buyers, not thin air). One buy per
// signal, sized at STAKE lamports or the per-reply size cap, whichever is
// smaller, and only when the cap alone is worth a real round trip.
//
// Exit: take profit at +30%, stop loss at -10%, a trailing exit once the
// coin ran +18% and then fell 10% off its peak, a momentum-decay exit when
// the fast EMA crosses back below the slow EMA (the trend that got us in is
// over — take what is there instead of riding it to the stop), or a stale
// exit after MAX_HOLD_SLOTS slots. Every exit sells the whole position.
// Pumps on pump.fun fade fast, so profits are taken quickly and losers are
// cut early; fees are about 1.25% a side plus a flat transaction fee, so the
// profit target still clears the round-trip cost several times over. At most
// MAX_OPEN positions are held, so capital rotates through many coins: the
// guardrail needs a real round trip on at least 20 distinct mints, and quick
// exits are what make room for the next coin.

import { LAMPORTS_PER_SOL, runBot, type BuyInput, type SellInput } from './vendor/makefun-bot.ts';

const SCALE = 1_000_000_000_000n;

// --- sizing -----------------------------------------------------------------
const STAKE_LAMPORTS = (LAMPORTS_PER_SOL * 3n) / 10n; // 0.30 SOL per buy
const MIN_BUY_LAMPORTS = LAMPORTS_PER_SOL / 50n; // 0.02 SOL: a real round trip
const MAX_SLIPPAGE_BPS = 2000; // 20%: fills survive fast moves, runs are not chased blindly

// --- signal -----------------------------------------------------------------
const MIN_TRADES = 8; // enough trades for the EMAs to mean something
const FAST_ALPHA_NUM = 25n; // fast EMA: 25% weight on the latest trade
const SLOW_ALPHA_NUM = 8n; // slow EMA: 8% weight on the latest trade
const ALPHA_DEN = 100n;
const CROSS_NUM = 103n; // fast EMA must beat slow EMA by 3%
const MIN_RISE_NUM = 105n; // price must be up 5% from creation
const MAX_RISE_NUM = 500n; // ... but not more than 5x from creation
const REBUY_COOLDOWN_SLOTS = 100;
const RECENT_TRADES = 10; // window for the buy-dominance check
const BUY_DOM_NUM = 3n; // buy SOL must be at least 1.5x sell SOL recently
const BUY_DOM_DEN = 2n;

// --- exit -------------------------------------------------------------------
const TAKE_PROFIT_NUM = 130n; // +30%
const STOP_LOSS_NUM = 90n; // -10%
const TRAIL_ARM_NUM = 118n; // trailing exit arms once up 18%
const TRAIL_NUM = 90n; // ... then sells 10% below the peak
const MAX_HOLD_SLOTS = 700;

interface RecentTrade {
  buy: boolean;
  sol: bigint;
}

interface CoinTrack {
  firstPrice: bigint;
  fastEma: bigint;
  slowEma: bigint;
  trades: number;
  entryPrice: bigint;
  entrySlot: number;
  peakPrice: bigint;
  lastExitSlot: number;
  recent: RecentTrade[];
}

const tracks = new Map<string, CoinTrack>();

function priceOf(virtualQuote: bigint, virtualToken: bigint): bigint {
  if (virtualToken <= 0n) return 0n;
  return (virtualQuote * SCALE) / virtualToken;
}

await runBot({
  onBatch(state, batch) {
    const { caps } = state.hello;
    const txFee = state.txFeeLamports();
    let free = state.freeCashLamports();
    let slots = caps.max_open_positions - state.committedPositionCount();
    const orders: Array<BuyInput | SellInput> = [];

    // Fold this batch's events into the per-coin tracks first: creation
    // prices from CreateEvent, EMA updates from every TradeEvent.
    const traded = new Set<string>();
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        const p = priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
        if (p > 0n && !tracks.has(e.mint)) {
          tracks.set(e.mint, {
            firstPrice: p,
            fastEma: p,
            slowEma: p,
            trades: 0,
            entryPrice: 0n,
            entrySlot: 0,
            peakPrice: 0n,
            lastExitSlot: -1_000_000,
            recent: [],
          });
        }
      } else if (e.event === 'TradeEvent') {
        traded.add(e.mint);
        const p = priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
        if (p <= 0n) continue;
        let t = tracks.get(e.mint);
        if (t === undefined) {
          t = {
            firstPrice: p,
            fastEma: p,
            slowEma: p,
            trades: 0,
            entryPrice: 0n,
            entrySlot: 0,
            peakPrice: 0n,
            lastExitSlot: -1_000_000,
            recent: [],
          };
          tracks.set(e.mint, t);
        }
        t.fastEma = (FAST_ALPHA_NUM * p + (ALPHA_DEN - FAST_ALPHA_NUM) * t.fastEma) / ALPHA_DEN;
        t.slowEma = (SLOW_ALPHA_NUM * p + (ALPHA_DEN - SLOW_ALPHA_NUM) * t.slowEma) / ALPHA_DEN;
        t.trades += 1;
        t.recent.push({ buy: e.is_buy, sol: BigInt(e.sol_amount) });
        if (t.recent.length > RECENT_TRADES) t.recent.shift();
        if (t.entryPrice > 0n && p > t.peakPrice) t.peakPrice = p;
      } else if (e.event === 'CompleteEvent') {
        tracks.delete(e.mint);
      }
    }

    // Exits first: free a slot (and realise the PnL) before deciding entries.
    for (const [mint, holding] of state.positions) {
      const curve = state.curves.get(mint);
      if (curve === undefined) continue;
      const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      if (price <= 0n) continue;
      const t = tracks.get(mint);
      if (t === undefined || t.entryPrice <= 0n) continue;
      const up = (price * 100n) / t.entryPrice;
      const offPeak = t.peakPrice > 0n ? (price * 100n) / t.peakPrice : 100n;
      const held = batch.slot - t.entrySlot;
      const takeProfit = up >= TAKE_PROFIT_NUM;
      const stopLoss = up <= STOP_LOSS_NUM;
      const trailing = up >= TRAIL_ARM_NUM && offPeak <= TRAIL_NUM;
      const decay = t.fastEma < t.slowEma;
      const stale = held >= MAX_HOLD_SLOTS;
      if (takeProfit || stopLoss || trailing || decay || stale) {
        orders.push({
          side: 'sell',
          mint,
          token_amount: holding.token_amount,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        });
        t.entryPrice = 0n;
        t.peakPrice = 0n;
        t.lastExitSlot = batch.slot;
      }
    }

    // Entries: only coins that traded in this batch, in event order, while
    // a position slot and cash remain.
    for (const mint of traded) {
      if (orders.length >= caps.max_orders_per_batch) break;
      if (slots <= 0) break;
      const t = tracks.get(mint);
      const curve = state.curves.get(mint);
      if (t === undefined || curve === undefined || curve.complete) continue;
      if (state.positions.has(mint)) continue;
      if (t.entryPrice > 0n) continue; // already holding (sell pending)
      if (batch.slot - t.lastExitSlot < REBUY_COOLDOWN_SLOTS) continue;
      if (t.trades < MIN_TRADES) continue;
      const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      if (price <= 0n) continue;
      const cross = (t.fastEma * 100n) / t.slowEma;
      const rise = (price * 100n) / t.firstPrice;
      if (cross < CROSS_NUM) continue;
      if (rise < MIN_RISE_NUM || rise > MAX_RISE_NUM) continue;
      let buySol = 0n;
      let sellSol = 0n;
      for (const r of t.recent) {
        if (r.buy) buySol += r.sol;
        else sellSol += r.sol;
      }
      if (buySol * BUY_DOM_DEN < sellSol * BUY_DOM_NUM) continue;
      const cap = state.maxBuyLamports(mint);
      if (cap < MIN_BUY_LAMPORTS) continue;
      const amount = cap < STAKE_LAMPORTS ? cap : STAKE_LAMPORTS;
      if (free < amount + txFee) continue;
      orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: MAX_SLIPPAGE_BPS });
      free -= amount + txFee;
      slots -= 1;
      t.entryPrice = price;
      t.entrySlot = batch.slot;
      t.peakPrice = price;
    }

    return orders;
  },
});
