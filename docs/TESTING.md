# Testing and evidence

## Local regression checks

Use Node.js 24 and run:

```bash
npm ci
npm run check
npm test
npm run lint
npm run format:check
```

Unit tests cover close sizing, invalid positions, signed PnL and rounding,
input validation, stale-oracle retry, bounded rate-limit backoff and the curated
public ABI boundary. Passing them does not prove live deployment compatibility.

## Fork E2E suite

Install [Foundry/Anvil](https://getfoundry.sh/anvil/overview). The test starts a
loopback-only Anvil fork on a temporary port. All writes, gas funding and token
holder impersonation occur there. It generates a disposable signer and never
forwards the operator's `PRIVATE_KEY`.

For the optional fork suite, add these values locally to `.env`;:

```dotenv
FORK_NETWORK=testnet
FORK_RPC_URL=YOUR_ARCHIVE_CAPABLE_MONAD_TESTNET_RPC
FORK_BLOCK_NUMBER=YOUR_RECENT_PINNED_BLOCK
FORK_SETTLEMENT_DONOR=PUBLIC_ADDRESS_WITH_TOKENS_AT_THAT_BLOCK
PYTH_API_KEY=YOUR_HERMES_KEY
FORK_INST_ID=YOUR_INSTRUMENT_ID
FORK_ORDER_SIZE=SMALL_VALID_RAW_SIZE
FORK_MAX_BUY_PRICE=RAW_LONG_PROTECTION_PRICE
FORK_MIN_SELL_PRICE=RAW_SHORT_PROTECTION_PRICE
FORK_LIMIT_PRICE=VALID_NON_CROSSING_BUY_PRICE
FORK_MODIFIED_LIMIT_PRICE=ANOTHER_VALID_NON_CROSSING_BUY_PRICE
FORK_FUNDING_AMOUNT=RAW_COLLATERAL_PER_PORTFOLIO
FORK_MARGIN_AMOUNT=RAW_IMP_MARGIN_ADJUSTMENT
```

The donor must hold twice the per-portfolio funding at the pinned block. Choose
an instrument enabled for IMP and CMP with valid 2x leverage, size steps,
notional and price ticks. Limit prices must not cross existing asks. Funding
must cover margin, fees and the IMP top-up; no trading defaults are invented.

```bash
npm run test:fork
```

The suite checks, for both portfolio types: deployment/funding, leverage,
resting limit creation/modification/cancellation, market opening, full
position-aware close, pending-order cleanup and withdrawal reconciliation. For
IMP it also checks margin addition/reduction and frozen collateral. CMP uses
shared collateral, so it has no per-position margin operation.

It restores its local snapshot and stops Anvil. Missing fixtures fail explicitly.
The storage state is block-pinned, but the local clock advances to accept fresh
signed Pyth data: this is not a fully deterministic historical replay. Retain
the block number and result before claiming E2E validation. A later real
testnet trade needs explicit approval and separately recorded receipts.

Historical forks may reject fresh Pyth updates as stale because fork time can
differ from live oracle time. Use `npm run oracle-dry-run` against the intended
live network to verify the oracle path separately.
