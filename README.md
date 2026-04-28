# eDMT Mint CLI

A local Node.js CLI for scanning pending eDMT/eNAT mint opportunities, verifying candidates with dry runs, and optionally broadcasting Ethereum mainnet mint transactions.

The default workflow is conservative: `mint` performs a dry run unless `--send` is explicitly provided.

## Features

- Scan pending mint candidates from the eDMT API.
- Filter candidates by burn value and sort by burn priority.
- Re-check block mintability before building or sending a transaction.
- Build calldata without requiring a private key.
- Broadcast through one or more RPC endpoints when real minting is enabled.
- Write JSON and CSV reports for review and later reconciliation.

## Requirements

- Node.js 20 or newer
- npm
- Ethereum mainnet RPC endpoint for live sending
- Private key only when using `--send`

## Setup

```bash
npm install
cp .env.example .env
```

On Windows PowerShell, use:

```powershell
Copy-Item .env.example .env
```

Edit `.env` as needed:

```ini
EDMT_API_BASE=https://api.edmt.io
RPC_URL=
RPC_URLS=
PRIVATE_KEY=
SCAN_LIMIT=100
MAX_TX=1
MIN_BURN_GWEI=0
GAS_MULTIPLIER=1.15
```

`PRIVATE_KEY` is not required for scans or dry runs. Only set it when you are ready to broadcast real Ethereum mainnet transactions.

## Commands

Scan pending candidates:

```bash
npm run scan -- --limit 20
```

Build a dry-run mint plan:

```bash
npm run dry-run -- --limit 50 --max-tx 3
```

Run the mint command without broadcasting:

```bash
npm run mint -- --limit 50 --max-tx 1
```

Broadcast real transactions:

```bash
npm run mint -- --limit 50 --max-tx 1 --send
```

Print JSON or CSV:

```bash
npm run scan -- --limit 20 --json
npm run dry-run -- --limit 20 --csv
```

Skip report files:

```bash
npm run dry-run -- --limit 20 --no-log
```

## CLI Options

| Option | Description |
| --- | --- |
| `--limit <n>` | Number of candidates to scan. Defaults to `SCAN_LIMIT` or `100`. |
| `--max-tx <n>` | Number of buildable mints to prepare or send. Defaults to `MAX_TX` or `1`. |
| `--min-burn-gwei <n>` | Minimum block burn in gwei. Defaults to `MIN_BURN_GWEI` or `0`. |
| `--gas-multiplier <n>` | Gas and fee multiplier for live sends. Defaults to `GAS_MULTIPLIER` or `1.15`. |
| `--gas-gwei <n>` | Use a fixed EIP-1559 max fee and priority fee in gwei. |
| `--max-gas-usd <n>` | Skip sending when estimated max gas cost exceeds this USD cap. |
| `--eth-usd <n>` | ETH/USD price used with `--max-gas-usd`. |
| `--send` | Broadcast real Ethereum mainnet transactions. |
| `--wait-receipt` | Wait for receipts after broadcasting. |
| `--json` | Print JSON output. |
| `--csv` | Print CSV output. |
| `--no-log` | Do not write `logs/*.json` and `logs/*.csv`. |

## Reports

By default, command output is saved under `logs/`:

- `logs/<timestamp>-scan.json`
- `logs/<timestamp>-scan.csv`
- `logs/<timestamp>-dry-run.json`
- `logs/<timestamp>-mint.json`

These files are ignored by git because they are runtime artifacts and may contain transaction metadata.

## Advanced Scripts

The `scripts/` directory contains experimental batch workflows:

- `scripts/batch-mint.js`
- `scripts/burst-mint.js`

They require `PRIVATE_KEY` and RPC configuration, and they are intended for controlled local use. Review the options in each script before running them.

Example:

```bash
node scripts/batch-mint.js --target 10 --maxUsd 0.3 --ethUsd 2400
```

## Testing

```bash
npm test
```

The current test suite uses Node's built-in test runner and mocked API responses.

## Safety Notes

- `mint` is dry-run only unless `--send` is present.
- Never commit `.env` or a private key.
- Use a dedicated wallet with limited funds for live minting.
- Prefer dry runs and small `--max-tx` values before larger runs.
- Multiple RPC URLs can be supplied with `RPC_URLS` to improve broadcast reliability.

## Repository

Intended remote:

```bash
git remote add origin https://github.com/trickter/edmt-mint.git
git push -u origin main
```
