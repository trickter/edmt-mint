# eDMT 批量 Mint 脚本开发方案

## Summary
做一个本地 Node.js CLI，用官方 eDMT API 扫描未 mint 区块，按 `burn` 从高到低筛选，先干跑生成 calldata，确认可 mint 后再按 nonce 顺序连续广播多笔 self-transfer 交易。默认只 dry-run，不花 gas；只有显式传 `--send` 才真实发主网交易。

当前干跑验证结果：官方 builder 已成功为区块 `14984204` 生成 mint calldata；同时最高候选 `19625398` 在几秒内被别人 mint，说明脚本必须支持二次校验和失败跳过。

## Key Changes
- 初始化一个轻量 Node.js 项目，使用 `viem` 发送 Ethereum mainnet 交易。
- 新增 CLI：
  - `scan`: 调 `https://api.edmt.io/api/v1/mints/pending` 获取候选区块。
  - `dry-run`: 逐个调用 `/api/v1/blocks/<blk>`、`/api/v1/mint/capture-fee`、`/api/v1/build/mint`，输出可 mint 列表和 calldata。
  - `mint --send`: 对 dry-run 通过的区块逐笔发送 `to = wallet.address, value = 0, data = calldata`。
- 配置 `.env`：
  - `RPC_URL`: Ethereum mainnet RPC。
  - `PRIVATE_KEY`: 真实发送时使用，不提交、不打印。
  - `EDMT_API_BASE=https://api.edmt.io`。
  - `MAX_TX`, `MIN_BURN_GWEI`, `GAS_MULTIPLIER`, `SCAN_LIMIT`。
- 批量 mint 采用“多笔交易顺序广播”，不是协议级单笔 batch mint，因为 spec 目前只有 `emt-mint`，没有 `emt-batch-mint`。

## Runtime Behavior
- 每个区块发送前都重新查询状态；如果 `minted_by != null` 或 builder 返回 `already minted`，自动跳过。
- capture fee 当前 API 显示未启用；但脚本会兼容 `feeRequired=true`，并只使用官方 `/build/mint` 返回的 calldata，避免 fee 字段拼错。
- nonce 本地串行管理，默认每笔等待 tx hash 后继续；可选等待 receipt/finality。
- 输出 CSV/JSON 日志：`blk`、`burn`、`calldata_text`、`txHash`、`status`、`error`。

## Test Plan
- Dry-run：扫描前 20-100 个候选，确认能生成 calldata。
- Race test：模拟候选已被 mint，确认脚本跳过并继续下一个。
- No-send safety：不带 `--send` 时绝不读取 `PRIVATE_KEY` 或广播交易。
- Broadcast smoke test：用 `MAX_TX=1 --send` 真实发一笔低风险 mint，检查 Etherscan tx 和 eDMT `/blocks/<blk>` 的 `minted_by`。
- Failure cases：RPC 失败、API 429、余额不足、gas 估算失败、nonce 冲突，都记录并不中断整个批次。

## Assumptions
- 使用 Ethereum mainnet。
- 默认优先 mint 高 `burn` 区块，因为不同区块价值不同，`burn` 越高携带的协议层数量越大。
- 第一版不做私有 relay；如抢高价值区块，再加 Flashbots/private RPC。
- 真实成功需要钱包有足够 ETH 支付 gas，且广播时目标区块仍未被别人抢先 mint。