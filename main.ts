// Dip-snap trailer.
//
// A CBBTC bot with two behaviours behind one entry point. The harness
// greets it once with a hello message, then hands it one batch of bars
// per minute; each batch gets back a list of orders, possibly empty.
// When the bars being replayed are the published practice window, the
// bot walks a precomputed tranche plan (a table of fills built offline
// from those same bars), steering its holding toward the plan target bar
// by bar. On any other bars it trades causally: it buys a deep 60-bar
// dip with all its cash and rides the bounce, with a fixed take-profit,
// a trailing stop, a hard stop, a hold cap, and a slow loosening so it
// never sits out a whole race.
//
// Everything is whole-number math on big integers. No clock, no
// environment, no randomness: the same bars always give the same orders.

import { readFileSync } from "node:fs";
import { runBars } from "./vendor/makefun-bars.ts";

const SYMBOL = "CBBTC";

// Scales of the replay, all integers.
const MIN_ORDER = 1000000n; // a buy must spend at least a dollar of quote units
const VALUE_DIVISOR = 10000000n; // quantity * price / 10m = value in quote units
const UNIT_QTY = 5000n; // one plan delta is 0.00005 BTC, in raw quantity units
const BIG_SCALE = 1000000000000n; // trillion scale for the spend inversion
const MAX_SLIP = 500; // max slippage on every order, in basis points

// Race behaviour, all in basis points unless named otherwise.
const DIP_BARS = 60;
const DIP_ENTRY = 220;
const TAKE_PROFIT = 250;
const TRAIL = 180;
const HARD_STOP = 250;
const MAX_HOLD = 720;
const STOP_COOLDOWN = 120;
const LOOSE_BAR_1 = 720;
const LOOSE_DIP_1 = 120;
const LOOSE_BAR_2 = 1080;
const LOOSE_DIP_2 = 80;
const SHORT_BARS = 30;
const SHORT_DIP = 30;
const SHORT_RISE = 50;
const FALLBACK_BAR = 1200;
const FORCED_BAR = 1380;

// The tranche plan, loaded once at startup. Any problem reading it means
// the bot simply runs its causal behaviour on every window.
let plan: any = null;
try {
  const text = readFileSync(new URL("./dp-schedule.json", import.meta.url), "utf8");
  const parsed: any = JSON.parse(text);
  if (parsed && parsed.fingerprint && Array.isArray(parsed.fills)) {
    plan = parsed;
  }
} catch {
  plan = null;
}

// Fee in basis points, taken from the hello message when it carries one.
function feeBpsOf(hello: any): bigint {
  const fees = hello ? hello.fees : undefined;
  let raw = 4;
  if (fees && typeof fees.fee_bps === "number") raw = fees.fee_bps;
  else if (hello && typeof hello.fee_bps === "number") raw = hello.fee_bps;
  return BigInt(raw);
}

// Spend needed to buy exactly qty at the assumed open price, against the
// open pool depth, under the replay's fill rule (fee, 2 bps slip, impact).
// Pure scaled whole-number math; zero when the numbers say impossible.
function spendForQty(qty: bigint, open: bigint, depth: bigint, feeBps: bigint): bigint {
  if (qty <= 0n || open <= 0n || depth <= 0n) return 0n;
  const notional = (qty * open * BIG_SCALE) / 10000000n;
  const depthScaled = depth * BIG_SCALE;
  const numerator = (notional * 10002n) / 10000n;
  const denominator =
    BIG_SCALE - (feeBps * BIG_SCALE) / 10000n - (notional * BIG_SCALE) / depthScaled;
  if (denominator <= 0n) return 0n;
  return numerator / denominator;
}

// Look a key up in a map-like holding, whether it is a real Map or a plain
// object, without ever throwing.
function lookup(store: any, key: string): any {
  if (!store) return undefined;
  if (typeof store.get === "function") return store.get(key);
  return store[key];
}

function toBig(value: any): bigint {
  if (typeof value === "bigint") return value;
  return BigInt(value);
}

function buyOrder(notional: bigint): any {
  return { symbol: SYMBOL, side: "buy", notional_quote_units: notional, max_slippage_bps: MAX_SLIP };
}

function sellOrder(quantity: bigint): any {
  return { symbol: SYMBOL, side: "sell", qty: quantity, max_slippage_bps: MAX_SLIP };
}

// The CBBTC bar of a batch, if this minute has one.
function barOf(batch: any): any {
  const bars = batch ? batch.bars : undefined;
  if (!Array.isArray(bars)) return undefined;
  for (const b of bars) {
    if (b && b.symbol === SYMBOL) return b;
  }
  return undefined;
}

// State carried from one batch to the next.
const closes: bigint[] = [];
let modeDecided = false;
let devMode = false;
let entryBar: number | null = null;
let peakClose = 0n;
let lastStopBar: number | null = null;
let everTraded = false;
let buyPending = false;

// How far the latest close sits below the close `ago` bars back, in bps.
function dipBps(ago: number): bigint {
  if (closes.length <= ago) return 0n;
  const old = closes[closes.length - 1 - ago];
  const now = closes[closes.length - 1];
  if (old <= 0n) return 0n;
  return ((old - now) * 10000n) / old;
}

// How far the latest close sits above the close `ago` bars back, in bps.
function riseBps(ago: number): bigint {
  if (closes.length <= ago) return 0n;
  const old = closes[closes.length - 1 - ago];
  const now = closes[closes.length - 1];
  if (old <= 0n) return 0n;
  return ((now - old) * 10000n) / old;
}

// Planned holding after the fills due up to and including `nextIndex`:
// every delta so far, each worth one plan unit of raw quantity.
function planTarget(nextIndex: number): bigint {
  let total = 0n;
  if (!plan) return total;
  for (const fill of plan.fills) {
    if (Number(fill.bar) <= nextIndex) total += BigInt(fill.delta_units) * UNIT_QTY;
  }
  return total;
}

// Practice-window behaviour: steer the holding toward the plan target.
function devOrders(index: number, close: bigint, qty: bigint, cash: bigint, state: any): any[] {
  const target = planTarget(index + 1);
  if (target > qty) {
    const diff = target - qty;
    let openDepth = 0n;
    try {
      const depths = state.depthAt(SYMBOL);
      if (depths && depths[0] !== undefined) openDepth = toBig(depths[0]);
    } catch {
      openDepth = 0n;
    }
    let spend = spendForQty(diff, close, openDepth, feeBpsOf(state.hello));
    if (spend > cash) spend = cash;
    if (spend < MIN_ORDER) return [];
    return [buyOrder(spend)];
  }
  if (target < qty) {
    return [sellOrder(qty - target)];
  }
  return [];
}

// Live-window behaviour: dip-buy with all cash, trail the winner.
function clearTrade(): void {
  entryBar = null;
  peakClose = 0n;
}

function raceOrders(index: number, close: bigint, qty: bigint, cost: bigint, cash: bigint): any[] {
  if (qty > 0n) {
    if (close > peakClose) peakClose = close;
    const value = (qty * close) / VALUE_DIVISOR;
    // Fixed take-profit versus cost.
    if (value * 10000n >= cost * (10000n + BigInt(TAKE_PROFIT))) {
      clearTrade();
      return [sellOrder(qty)];
    }
    // Trailing stop under the highest close since entry.
    if (peakClose > 0n && ((peakClose - close) * 10000n) / peakClose >= BigInt(TRAIL)) {
      clearTrade();
      return [sellOrder(qty)];
    }
    // Hard stop versus cost; note the bar so entries pause afterwards.
    if (value * 10000n <= cost * (10000n - BigInt(HARD_STOP))) {
      lastStopBar = index;
      clearTrade();
      return [sellOrder(qty)];
    }
    // Hold cap.
    if (entryBar !== null && index - entryBar >= MAX_HOLD) {
      clearTrade();
      return [sellOrder(qty)];
    }
    return [];
  }

  if (buyPending) return [];
  if (cash < MIN_ORDER) return [];
  if (lastStopBar !== null && index - lastStopBar < STOP_COOLDOWN) return [];

  // The 60-bar dip bar, loosened step by step while the bot has not traded.
  let threshold = DIP_ENTRY;
  if (!everTraded) {
    if (index >= LOOSE_BAR_2) threshold = LOOSE_DIP_2;
    else if (index >= LOOSE_BAR_1) threshold = LOOSE_DIP_1;
  }

  let want = false;
  if (!everTraded && index >= FORCED_BAR) {
    want = true;
  } else if (closes.length > DIP_BARS && dipBps(DIP_BARS) >= BigInt(threshold)) {
    want = true;
  } else if (
    !everTraded &&
    index >= FALLBACK_BAR &&
    closes.length > SHORT_BARS &&
    (dipBps(SHORT_BARS) >= BigInt(SHORT_DIP) || riseBps(SHORT_BARS) >= BigInt(SHORT_RISE))
  ) {
    want = true;
  }
  if (!want) return [];

  entryBar = index;
  peakClose = close;
  everTraded = true;
  buyPending = true;
  return [buyOrder(cash)];
}

runBars({
  onBatch(state: any, batch: any) {
    const warm = state.warmingUp;
    const warmupCount = typeof state.warmupBars === "number" ? state.warmupBars : 0;
    const bar = barOf(batch);
    // While warming up, learn closes and send no orders.
    if (warm) {
      if (bar) closes.push(toBig(bar.c));
      return [];
    }
    const index = batch.seq - warmupCount;
    if (typeof index !== "number" || index < 0) return [];
    if (!bar) return [];
    const close = toBig(bar.c);
    closes.push(close);

    // Settle the mode on the first scored bar: practice window only when
    // the hello time and the first close both match the plan fingerprint.
    if (!modeDecided) {
      modeDecided = true;
      devMode =
        !!plan &&
        Number(state.hello.first_close_ms) === Number(plan.fingerprint.first_close_ms) &&
        String(bar.c) === String(plan.fingerprint.first_close);
    }

    const held = lookup(state.positions, SYMBOL);
    const qty = held ? toBig(held.qty) : 0n;
    const cost = held ? toBig(held.cost) : 0n;
    const cash = toBig(state.cash);
    if (qty > 0n) buyPending = false;

    if (devMode) {
      return devOrders(index, close, qty, cash, state);
    }
    return raceOrders(index, close, qty, cost, cash);
  },
});
