# DRX ABI Trading Template

A minimal, self-custody, educational TypeScript template for interacting with Drake perpetual-trading contracts on Monad. It is not financial, trading, or investment advice. It publishes the minimum integration ABIs, versioned network configuration, and a market-order example that simulates by default.

## Start here

Read the complete [integration guide](docs/INTEGRATION_GUIDE.md) before running a transaction. It covers RPC and Pyth setup, portfolio funding, ABI versioning, oracle-update payloads, integer scales, slippage, delegation, and production safety.

## Quick start

```bash
npm ci
cp .env.example .env
# Fill RPC_URL, PRIVATE_KEY, and PYTH_API_KEY locally. Never commit .env.

# Default network is Monad testnet: acquire test MON/AUSD before executing.

# Read-only Pyth/OracleRouter compatibility check: no wallet or transaction.
npm run oracle-dry-run -- --network testnet --inst-id 1

# Create or locate a selected portfolio. `--fund` is raw AUSD (1e6) units.
npm run prepare-portfolio -- --portfolio-type imp --fund 1000000

# Simulate only (the default): no transaction is broadcast.
npm run market-order -- --portfolio-type imp --inst-id 1 --side long --size 100 --slippage-limit "$PROTECTION_PRICE"

# Only after reviewing the calldata and using a small funded portfolio:
npm run prepare-portfolio -- --portfolio-type cmp --fund 1000000 --execute --acknowledge-live-risk
npm run market-order -- --portfolio-type cmp --inst-id 1 --side long --size 100 --slippage-limit "$PROTECTION_PRICE" --execute --acknowledge-live-risk

# Inspect the full lifecycle state for one instrument.
npm run portfolio-state -- --network testnet --portfolio-type cmp --owner 0xYourEOA --inst-id 1
```

`size` and `slippage-limit` are protocol integers, not decimal UI values. Read the instrument's live validation parameters and calculate the protection price before using `--execute`.

## Repository layout

- `abi/` — `Trading`, IMP/CMP portfolios, `PortfolioFactory`, and `OracleRouter` integration ABIs.
- `config/` — Monad mainnet addresses and approved Pyth feed IDs; verify before live use.
- `config/testnet.json` — Monad testnet addresses and matching Pyth feed IDs; use before mainnet.
- `examples/prepare-portfolio.ts` — creates/locates IMP or CMP and optionally funds it with AUSD.
- `examples/market-order.ts` — selected IMP/CMP market-order example; simulation is the default.
- `examples/order-lifecycle.ts` — limit create/modify/cancel and position-aware full-close flows.
- `examples/portfolio-manage.ts` — leverage, IMP margin adjustment and owner withdrawal.
- `examples/portfolio-state.ts` — balance, position, PnL/margin and pending-order snapshots.
- `docs/INTEGRATION_GUIDE.md` — full integration and operational guide.

## Safety boundary

An ABI does not grant authorization. Only the portfolio owner—or an explicitly
registered trading delegate—can trade that portfolio. A delegate cannot
withdraw, but can take trading risk. Use a dedicated EOA and store
`PRIVATE_KEY` and `PYTH_API_KEY` only in the ignored local `.env` created from
`.env.example`, or an equivalent secret manager. Never commit, publish, or
share that file. Do not expose either key in frontend code; do not put a
trading private key in a shared service.

## Development

Use Node.js 24, matching the Hermes dependency requirement.
Run `npm run check`, `npm run lint`, and `npm run format:check`.
See [CHANGELOG.md](CHANGELOG.md) for changes. Contract addresses and feeds are maintained in config files.

The scripts remain examples. A local Anvil fork suite is included but needs
deployment-specific fixtures; see [docs/TESTING.md](docs/TESTING.md).

## License

Licensed under [Apache License 2.0](LICENSE). It permits commercial and
derivative use, subject to its notice, license, trademark, and patent terms.
