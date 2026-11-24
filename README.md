# Pump Momentum — Paper Bot

[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/Krwanz/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/Krwanz/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A deterministic momentum paper-trading bot for the [Pump.fun Replay Sprint — Paper Bot, Real Ranking](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) bounty on [make.fun](https://make.fun). It trades 10 SOL of paper money on a replay of recorded pump.fun bonding-curve activity. Nothing is traded for real: no real capital, no API keys, no Solana payments.

Play code: `a15ed58m`

## Strategy

Early-momentum trend following on bonding-curve prices (see `main.ts`):

- **Entry:** a coin becomes a candidate at its `CreateEvent`. On every trade the bot updates a fast and a slow EMA of its price. It buys when the fast EMA crosses clearly above the slow EMA **and** the price is already up at least 10% from creation (real buying pressure) but not more than 5x (no chasing the top). One buy per signal, 0.30 SOL or the per-reply size cap, whichever is smaller.
- **Exit:** take profit at +40%, stop loss at −18%, a trailing exit once up 20% then 15% off the peak, or a stale exit after 1,500 slots. Every exit sells the whole position.
- **Risk:** at most 5 open positions, so capital rotates through many coins; the guardrail needs a real round trip on at least 20 distinct mints.
- **Determinism:** no clock, no environment, no unseeded randomness — the two grading executions produce byte-identical action logs.

## Run it

The grader runs `node /bot/main.ts` (Node 22.18+ runs the TypeScript as-is). The bot speaks the `agent-fun/replay/v2` protocol on stdin/stdout: `hello`, one `batch` per slot, `done`; it answers every batch with one `reply` carrying its orders. The wire shim is vendored at `vendor/makefun-bot.ts` (the kit's SDK, byte-identical).

## License

MIT — see [LICENSE](LICENSE).
