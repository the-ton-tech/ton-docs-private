# Gasless — issues

## A. Correctness / UX

### A1. `bounce: true` hard-coded — Medium

[packages/walletkit/src/defi/gasless/tonapi/utils.ts:48](packages/walletkit/src/defi/gasless/tonapi/utils.ts#L48). `buildInternalMessageCell` always emits `bounce: true`. Right for jetton transfers, wrong for any deploy / contract-call payload.
**Fix:** add `bounce?: boolean` to `TransactionRequestMessage`, default `true`.

### A2. `GaslessError.UNSUPPORTED_FEE_JETTON` declared, never thrown — Low

[packages/walletkit/src/defi/gasless/errors.ts:12](packages/walletkit/src/defi/gasless/errors.ts#L12) (source carries `// never used?`).
**Fix:** either remove or throw it from the A6 pre-flight check.

### A3. No feature-detection guard in actions — Medium

[sign-message.ts:29-40](packages/appkit/src/actions/transaction/sign-message.ts#L29-L40), [send-gasless-transaction.ts:42-50](packages/appkit/src/actions/gasless/send-gasless-transaction.ts#L42-L50). Call `wallet.signMessage(...)` without checking `wallet.getSupportedFeatures()`. Consumers get whatever TonConnect throws at click time.
**Fix:** throw a typed error before invoking the wallet. Pairs with A10.

### A4. `appkit-minter` hardcodes mainnet, no API key — Medium

[apps/appkit-minter/src/core/configs/app-kit.ts:40-42, :59](apps/appkit-minter/src/core/configs/app-kit.ts#L40-L42). `new TonApiClient({ baseUrl: 'https://tonapi.io' })`, single provider registered for mainnet. Testnet users silently fail.
**Fix:** thread `ENV_TON_API_KEY_*`, register one provider per `chainId`, add a network-mismatch banner.

### A5. `GaslessPage` does not estimate before sending — Low

[apps/appkit-minter/src/pages/gasless-page.tsx](apps/appkit-minter/src/pages/gasless-page.tsx). User clicks "Send Gasless" without seeing the fee. `useEstimateGasless` ships but is unused.
**Fix:** unblocks naturally once A8 lands.

### A6. No pre-flight fee-jetton balance check — High

If the wallet has no fee-jetton balance, the relayer rejects after the user has signed. Generic error.
**Fix:** resolve the user's jetton-wallet for `feeJettonMaster`, check `balance >= estimate.fee` before `wallet.signMessage`. Skippable via a flag.

### A7. Send action returns no settlement handle — Medium

[send-gasless-transaction.ts:77-80](packages/appkit/src/actions/gasless/send-gasless-transaction.ts#L77-L80) returns `{ internalBoc, fee }`. Consumers need a stable identifier for explorer links and tracking.
**Fix:** return `{ internalBoc, internalHash, fee, validUntil }`. Helper exists for sends: [getNormalizedExtMessageHash](packages/walletkit/src/utils/getNormalizedExtMessageHash.ts) — add the internal-message equivalent.

### A8. Estimate duplicated inside `sendGaslessTransaction` — Medium

[send-gasless-transaction.ts:54-62](packages/appkit/src/actions/gasless/send-gasless-transaction.ts#L54-L62) inlines the same `gaslessManager.estimate(...)` call as [estimate-gasless.ts:44-52](packages/appkit/src/actions/gasless/estimate-gasless.ts#L44-L52). UIs that already estimated re-estimate, paying for two round-trips and risking fee drift.
**Fix:** overload `sendGaslessTransaction(appKit, { estimate })` to accept a pre-computed `GaslessEstimateResult`. Resolves C3.

### A9. No idempotency on retry after sign succeeded — Low

If `signMessage` succeeded but `send` failed, the user has to re-sign even though the BoC is still valid until `validUntil`.
**Fix:** cache the signed BoC and expose `retrySend(internalBoc)`. Defer until telemetry justifies.

### A10. No `maxMessages` enforcement on `SignMessage` — Low

W5R1 advertises `maxMessages: 255` ([WalletV5R1Adapter.ts:401-404](packages/walletkit/src/contracts/w5/WalletV5R1Adapter.ts#L401-L404)); V4R2 does not declare `SignMessage` at all. Action validates neither.
**Fix:** read `wallet.getSupportedFeatures()` and throw before the popup. Pairs with A3.

## B. Type / API precision

### B1. Plain `Error` in actions — Medium

[get-gasless-config.ts:20](packages/appkit/src/actions/gasless/get-gasless-config.ts#L20), [estimate-gasless.ts:26](packages/appkit/src/actions/gasless/estimate-gasless.ts#L26), [send-gasless-transaction.ts:32](packages/appkit/src/actions/gasless/send-gasless-transaction.ts#L32) all set `*ErrorType = Error`. Guards throw bare `new Error('Wallet not connected')`.
**Fix:** promote walletkit's `GaslessError` (with codes) to the action layer.

### B2. `MutationOptions` instead of `MutateOptions` on `*Mutate`/`*MutateAsync` — Low

[queries/gasless/estimate-gasless.ts:47, :52](packages/appkit/src/queries/gasless/estimate-gasless.ts#L47), [queries/gasless/send-gasless-transaction.ts:47-52, :57-62](packages/appkit/src/queries/gasless/send-gasless-transaction.ts#L47-L62) use `MutationOptions` (too permissive — includes `mutationFn`). Every other mutation file in the package uses `MutateOptions`. Reference: [queries/transaction/sign-message.ts:57](packages/appkit/src/queries/transaction/sign-message.ts#L57).

### B3. `mutationFn` arrow vs method-shorthand — Cosmetic

Codebase uses method-shorthand in 11 files; gasless and `onramp/build-onramp-url.ts` use arrows. [estimate-gasless.ts:36](packages/appkit/src/queries/gasless/estimate-gasless.ts#L36), [send-gasless-transaction.ts:36](packages/appkit/src/queries/gasless/send-gasless-transaction.ts#L36).

### B4. Missing `'use client'` on 2 gasless mutation hooks — Medium

[use-estimate-gasless.ts](packages/appkit-react/src/features/gasless/hooks/use-estimate-gasless.ts), [use-send-gasless-transaction.ts](packages/appkit-react/src/features/gasless/hooks/use-send-gasless-transaction.ts). Every comparable mutation hook ships the directive (`use-send-transaction`, `use-transfer-ton`, `use-transfer-jetton`, etc.). Next.js App Router consumers break server-side. One line per file.

## C. Docs / SDK drift

### C1. 3 gasless hooks missing from `hooks.md` — Medium

[packages/appkit-react/docs/hooks.md](packages/appkit-react/docs/hooks.md) and its template document `useSignMessage` only — no entries for `useGaslessConfig`, `useEstimateGasless`, `useSendGaslessTransaction`.
**Fix:** point the docs generator at `features/gasless`, or author the three sections.

### C2. Demo snippets disagree on `validUntil` — Low

[demo/examples/src/appkit/actions/transaction/sign-message.ts:14-21](demo/examples/src/appkit/actions/transaction/sign-message.ts#L14-L21) omits `validUntil`; [demo/examples/src/appkit/hooks/transaction/use-sign-message.tsx:16-24](demo/examples/src/appkit/hooks/transaction/use-sign-message.tsx#L16-L24) includes it. The two land adjacent in the published docs.
**Fix:** add `validUntil` to the action snippet.

### C3. `gasless.mdx` documents an SDK that doesn't exist — High

[ecosystem/appkit/howto/gasless.mdx:20-35](../ton-docs-private/ecosystem/appkit/howto/gasless.mdx#L20-L35) is published and wrong on four counts:

| Doc claim | Actual SDK |
| --- | --- |
| `getGaslessConfig(appKit, { network })` | `getGaslessConfig(appKit, { providerId? })` |
| `config.gasJettons[0]` | `config.supportedGasJettons[0]` |
| `estimateGasless(appKit, { network, gasJetton, messages })` | `estimateGasless(appKit, { feeJettonMaster: string, messages, providerId? })` |
| `sendGaslessTransaction(appKit, { estimate })` | `sendGaslessTransaction(appKit, { feeJettonMaster, messages, providerId? })` — no `{ estimate }` overload |

**Fix:** ship A8 (`{ estimate }` overload) so the doc becomes truthful; rewrite the rest to match the SDK. The aspirational shape is the better DX.