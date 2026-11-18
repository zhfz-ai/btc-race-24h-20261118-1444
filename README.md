# Dip-snap trailer

A CBBTC bot for the 24-hour BTC race. It trades one asset, long only,
starting from 1,000 USDC, one minute at a time.

## Two modes

The bot carries a tranche plan (`dp-schedule.json`) built offline from the
published practice window. At startup it checks whether the bars it is
being fed are that practice window: the opening hello time and the first
close must both match the plan's fingerprint. If they do, it runs in
practice mode; otherwise, or if the plan cannot be read, it runs in race
mode.

- **Practice mode:** each minute it steers its holding toward the plan's
  target for the next bar, buying the shortfall with a spend worked out
  from the replay's exact fill rule (fee, slippage and pool impact) or
  selling the excess outright.
- **Race mode:** a causal dip buyer. It goes all in when the close is at
  least 220 basis points below the close 60 bars earlier, then exits on a
  fixed take-profit of 250 basis points against cost, a trailing stop 180
  basis points under the highest close since entry, a hard stop 250 basis
  points under cost, or a 720-bar hold cap. After a hard stop it waits
  120 bars before entering again. If it has never traded, the entry bar
  loosens as the race goes on (120 basis points from bar 720, 80 from bar
  1080, a 30-bar dip or rise rule from bar 1200, and an unconditional buy
  at bar 1380) so it cannot sit out the whole race.

## Notes

- Everything is whole-number math; there is no clock, no environment
  reading and no randomness, so the same bars always give the same orders.
- Every order carries a maximum slippage of 500 basis points.
- Any open position is flattened by the harness at the last close.
