# Drake integration guide

## Install and configure

Fork the repository into your account, or clone it directly for local experimentation:

```bash
git clone https://github.com/drxprotocol/drx-abi-trading-template.git
cd drx-abi-trading-template
npm ci
cp .env.example .env
```

The repository includes its ABIs. No separate contract checkout or ABI copying is required.
Set `RPC_URL`, `PRIVATE_KEY`, and `PYTH_API_KEY` locally. Do not commit secrets.
Read-only `portfolio-state` needs only RPC_URL and a public owner address.

## Network and RPC

Commands default to `--network testnet`. The shared utility in `src/network.ts`
queries the RPC chain ID, loads the matching JSON configuration, validates its
shape, and checks that it matches the requested network. Unsupported chains
and mainnet/testnet mismatches fail before transactions.

Contract addresses and feed mappings live only in `config/`. RPC endpoints
belong in `.env`; public examples are provided in `.env.example`.
For authenticated access, create an application and copy its HTTPS endpoint
from the [Alchemy dashboard](https://dashboard.alchemy.com/). Consult the
[Monad RPC page](https://www.alchemy.com/rpc/monad) for supported networks.
Public RPCs may have lower throughput or inconsistent availability.

Testnet requires test MON for gas and the configured test settlement token.
Use the official Drake testnet distribution channel if test collateral is
available; this template does not mint it. Mainnet uses real MON and
collateral. Test tokens have no cash value. Explicitly choose `--network
mainnet` when ready.

## Pyth

Obtain a key through the [Pyth API-key guide](https://docs.pyth.network/price-feeds/pro/acquire-api-key)
and ensure it includes access to the Hermes endpoint used by the examples.
Keep the key server-side. See [fetching signed updates](https://docs.pyth.network/price-feeds/core/fetch-price-updates)
for the payload format. Subscription terms and trial availability should be
confirmed with Pyth rather than assumed from this guide.

The scripts fetch signed update bytes immediately before each simulation and
never cache or reuse them. They retry only selected stale-price and temporary
transport failures _before_ broadcasting, with a new payload and bounded
backoff. The contract verifies freshness, confidence, and execution constraints.
A payload is not a guarantee of the execution price. Never blindly resubmit
after an uncertain broadcast outcome.

### Verify the live Pyth path without trading

Use the following before funding or placing an order:

```bash
npm run oracle-dry-run -- --network testnet --inst-id 1
npm run oracle-dry-run -- --network mainnet --inst-id 1
```

This performs a read-only `eth_call` of
`OracleRouter.updateAndGetInstPrice` with a fresh signed payload. It needs
`RPC_URL` and `PYTH_API_KEY`, but no wallet or portfolio, and does not broadcast
or persist an update. A successful result proves that this RPC, selected
network, configured feed, Hermes payload format and deployed oracle route are
compatible at that instant. It does **not** prove that an account is funded, a
portfolio exists, order validation passes, or a trade can execute.

Run this check immediately before a live integration test; oracle freshness is
time-sensitive.

## Portfolio preparation

```bash
npm run prepare-portfolio -- --portfolio-type imp --fund 1000000
```

IMP is isolated margin; CMP shares collateral across positions. Select
`--portfolio-type cmp` for CMP. `--fund` is an additional transfer on each run,
not a target balance. On the current six-decimal settlement token, 1000000 is
one token. Fund the EOA first. If the portfolio is missing, dry-run simulates
creation and stops; later dependent transactions need the created state.

Add `--execute --acknowledge-live-risk` to deliberately submit each command.
Creation and funding are separate transactions, so creation can succeed while
funding fails. Inspect state before retrying.

## Inspect state

```bash
npm run portfolio-state -- --portfolio-type imp --owner YOUR_PUBLIC_ADDRESS --inst-id 1
```

This reads a single-block snapshot: raw settlement balance, available/frozen
collateral, active instruments, position state/side/size/average price,
leverage, order-book pending-order IDs and data, and—when an oracle valuation
is available—gross/net margin plus PnL split into price movement and
funding/borrowing adjustment. A failed valuation is reported as unavailable;
it is never presented as zero PnL.

## Market and limit orders

Use the actual instrument's size step, bounds, and current price. These shell
variables are values you must calculate; they are not built-in defaults:

```bash
npm run market-order -- --portfolio-type imp --inst-id 1 --side long --size "$SIZE" --slippage-limit "$MAX_BUY_PRICE"
npm run order-lifecycle -- --portfolio-type imp --action create-limit --inst-id 1 --side long --size "$SIZE" --limit-price "$LIMIT_PRICE" --tif gtc --post-only
npm run order-lifecycle -- --portfolio-type imp --action modify-limit --inst-id 1 --order-id "$ORDER_ID" --size "$NEW_SIZE" --limit-price "$NEW_PRICE"
npm run order-lifecycle -- --portfolio-type imp --action cancel --inst-id 1 --order-id "$ORDER_ID"
```

Size is in protocol base units (10000 represents one base unit); price is in
six-decimal units. A LONG protection price is the maximum acceptable price;
a SHORT protection price is the minimum. Simulation enforces the contract's
current constraints. GTC, IOC, and FOK are available for limit creation;
modification is subject to the protocol's resting/post-only order rules.

To close, cancel this instrument's pending orders first, then let the command
derive the opposite side and exact observed size from the portfolio snapshot:

```bash
npm run order-lifecycle -- --portfolio-type imp --action close --inst-id 1 --slippage-limit "$MIN_SELL_PRICE"
```

It rejects manually supplied side/size, open pending orders and non-open
positions. A successful receipt is followed by a state reread; an unexpectedly
open position is a reconciliation failure, not a signal to resubmit blindly.

## Portfolio management

Only a portfolio owner can withdraw. Owners and explicitly registered trading
delegates can change leverage and use Trading's margin flow. All values are raw
protocol units and should be simulated first:

```bash
npm run portfolio-manage -- --portfolio-type imp --action leverage --inst-id 1 --leverage 2
npm run portfolio-manage -- --portfolio-type imp --action add-margin --inst-id 1 --amount "$AMOUNT"
npm run portfolio-manage -- --portfolio-type imp --action reduce-margin --inst-id 1 --amount "$AMOUNT"
npm run portfolio-manage -- --portfolio-type imp --action withdraw --inst-id 1 --amount "$AMOUNT"
```

Per-position margin changes apply only to IMP. CMP has shared collateral, so
fund it with `prepare-portfolio --fund` and withdraw unused collateral. Add
`--execute --acknowledge-live-risk` only after an independent review. Every
write uses the account's pending nonce and waits for a receipt; one writer per
EOA is still required because a pending-nonce read is not a cross-process lock.

Receipts are checked for success. Portfolio state is reread after market
orders. Run only one writer per EOA: reading the pending nonce is not a lock
against other processes. If a receipt cannot be obtained, investigate the
transaction before running another command.

## Delegation

These scripts sign as the portfolio owner. Protocol delegation allows trading,
leverage changes, pending-order management, margin adjustment, and applicable
same-owner portfolio transfers. It can cause trading losses even though
withdrawals remain owner-only. The owner revokes delegation by calling
`Trading.setTradingDelegate` with the zero address. Delegation is not enabled
automatically by these examples.

## Validation and limits

Run `npm run check`, `npm run lint`, and `npm run format:check` before sharing
changes. Run `npm run test:fork` only after configuring its deliberately local
fixtures; see [TESTING.md](TESTING.md). This is educational integration code,
not a trading strategy or a guarantee of profit or successful execution.
