# Sluice

**A safety-gated REST bridge between any agent, script or no-code tool and Filecoin Onchain Cloud's payments and proofs.**

Filecoin Onchain Cloud gives you verifiable storage (PDP) and programmable payments (Filecoin Pay) — but the only official way in is the Synapse SDK, which is JS/TS-only and expects a private key in your app. And nothing sits between "an agent decides to pay" and "the payment executes."

Sluice is that missing piece: **plain REST access to Filecoin Pay and PDP, with two independent spend guardrails — one enforced by Sluice, one enforced by the chain.**

**Filecoin Calibration testnet only.**

---

## How it works

Sluice never holds your private key. You keep your USDFC in **your own** Filecoin Pay account and grant Sluice bounded **operator** rights on-chain:

```
setOperatorApproval(USDFC, sluiceWallet, true, rateAllowance, lockupAllowance, maxLockupPeriod)
```

From then on your agents call plain HTTP. Sluice signs with its own key, acting on your account, and Filecoin Pay itself rejects anything outside the limits you set — `OperatorRateAllowanceExceeded`, `OperatorLockupAllowanceExceeded`, `LockupPeriodExceedsOperatorMaximum`.

**The property that makes this safe:** `withdraw` and `withdrawTo` revert with `CallerNotPayer`. An operator can direct your funds through payment rails but **can never pull them out to itself**. Revoke any time with `approve: false`.

So there are two gates, and they fail independently:

| Gate | Enforced by | What it limits |
|---|---|---|
| API key cap | Sluice | Per-request auto-approval ceiling; above it, a human decides |
| Operator allowance | Filecoin Pay contract | The hard ceiling of everything Sluice can ever commit |

---

## The API

### Agent endpoints — Sluice signs as your operator

| Endpoint | Auth | Purpose |
|---|---|---|
| `POST /api/v1/pay/authorize` | API key | Price an operation, then execute (under cap) or hold it (over cap) |
| `GET /api/v1/pay/status/:id` | API key | Poll; also confirms transactions and expires stale requests |
| `POST /api/v1/pay/approve/:id` | Firebase ID token | Release or reject a held payment |
| `GET /api/v1/pay/list` | API key | The calling key's history |
| `GET /api/v1/verify/:pieceCid` | none | PDP proof status as plain JSON |
| `GET /api/v1/health` | none | Operator wallet and gas balance |
| `GET /api/v1/stats` | none | Aggregate counters for the landing page |

Payment kinds: `pay`, `modify_rate`, `terminate_rail`, `store`.

```jsonc
{"kind": "pay", "to": "0x...", "amount": "0.5"}          // one-time payment
{"kind": "pay", "to": "0x...", "amount": "0.5", "railId": "17"}  // reuse a rail, saves a tx
{"kind": "modify_rate", "railId": "17", "ratePerEpoch": "0.001"} // streaming rate
{"kind": "terminate_rail", "railId": "17"}
{"kind": "store", "dataBase64": "aGVsbG8=", "label": "run-42"}
```

### Browser actions — only your own wallet can sign these

`deposit`, `withdraw`, `approve_operator`, `revoke_operator`, `approve_service`, `settle`.

This is not a policy choice — Filecoin Pay restricts them to the account holder, so Sluice *could not* do them for you. They live in the dashboard. Asking for one over REST returns a 400 that says so.

---

## Setup

### 1. Install

```bash
pnpm install
cp .env.example .env.local
```

### 2. Fund the operator wallet

Sluice's own wallet needs **tFIL for gas only** — it never holds user funds.

- tFIL: https://faucet.calibnet.chainsafe-fil.io

Put the key in `SLUICE_WALLET_PRIVATE_KEY`. **Testnet keys only.**

Each *user* additionally needs tFIL (gas) and tUSDFC (to spend):

- tUSDFC: https://forest-explorer.chainsafe.dev/faucet/calibnet_usdfc

### 3. Firebase

Create a project, then:

- **Firestore** — enable it.
- **Authentication → Sign-in method** — enable **Google**.
- **Authentication → Settings → Authorized domains** — add your deployment domain. Miss this and sign-in fails with `auth/unauthorized-domain`.
- **Project settings → Service accounts** → generate a key → `FIREBASE_SERVICE_ACCOUNT_KEY`.
- **Project settings → Your apps → Web** → copy config into `NEXT_PUBLIC_FIREBASE_*`.

```bash
firebase deploy --only firestore:rules,firestore:indexes
```

> `firestore.rules` is multi-tenant: a user reads only rows where `ownerUid` matches their own uid, and **no browser can write anything**. Every state change goes through an authenticated API route. Without this, one user could read another's payments — or an agent could approve its own.

### 4. WalletConnect (optional)

Set `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` from https://cloud.reown.com. Without it, browser-extension wallets still work; only the mobile QR flow is unavailable.

### 5. Verify the chain works

```bash
pnpm spike                    # balances, pricing, data sets, rails
pnpm spike -- --upload        # store a piece and read its proof status
```

If this fails, the problem is the wallet, a faucet or the RPC — not Sluice.

### 6. Run

```bash
pnpm dev
```

Then in the dashboard: sign in with Google → connect wallet → **link** (sign a message, no gas) → **grant operator access** (one on-chain tx) → **deposit** USDFC → **create an API key**.

---

## Try it

```bash
export SLUICE_URL=http://localhost:3000
export SLUICE_API_KEY=sluice_sk_...
export SLUICE_PAYEE=0x...
python examples/demo.py
```

---

## Design notes

**Two-step delegation.** Signing the link message proves address ownership and costs no gas; it authorises nothing. Spending comes from a separate, explicit, revocable on-chain grant. Keeping them apart means a phishing signature cannot move money.

**Nonce serialisation.** Every transaction comes from one operator wallet, so two concurrent serverless invocations signing at once means one reverts. [`lock.ts`](lib/sluice/lock.ts) holds a Firestore-transaction mutex with a TTL, so a crashed invocation cannot wedge the wallet. Concurrent callers get a 429.

**Broadcast, then confirm on poll.** Calibration blocks are ~30s — far longer than a serverless function should sit blocked. `execute()` returns once signed; `/pay/status/:id` picks up the receipt on a later poll. The caller's own loop drives confirmation, so nothing needs to stay alive on Vercel.

**Allowance checked twice.** Once when pricing, once at execution — a held request may sit for an hour, and the user could have lowered or revoked the grant in between.

**PieceCID, not CID.** PDP addresses pieces by PieceCID (`bafkzc…`). There is no global CID→provider index on Filecoin, so `/verify` uses the mapping cached at upload time, falling back to scanning the data sets owned by `?client=`.

**Storage is gateway-owned.** `store` uploads to Sluice's own Warm Storage account, not the user's. Uploading as another party needs **session keys**, and the SDK's session-key permissions (`CreateDataSet`, `AddPieces`, `SchedulePieceRemovals`, `TerminateService`) are storage-only and entirely separate from the payments grant. Recorded honestly on each record as `onGatewayAccount: true`.

**`@x402/*` dev dependencies.** RainbowKit statically imports wagmi's Base connector, which reaches Coinbase's SDK and its optional x402 peers. They are installed only so the bundler can resolve them; Sluice never executes that path.

---

## Deliberately not built

- Multi-chain support. Filecoin only.
- Mainnet. Calibration only — the chain is pinned in [`synapse.ts`](lib/sluice/synapse.ts).
- A raw USDFC transfer kind. It would not be Filecoin Pay.
- Per-user storage accounts. Needs session keys; see above.
- Uploads beyond 512 KiB. Use the Synapse SDK directly.

---

## Layout

```
app/api/v1/pay/        Agent endpoints (Node runtime)
app/api/v1/account/    Wallet linking, operator grant, API keys
app/dashboard/         Wallet setup, key management, live approvals
app/docs/              API reference
lib/sluice/operator.ts Acting as an approved operator on a user's account
lib/sluice/executor.ts Pricing and execution
lib/sluice/users.ts    Account records and wallet-link verification
lib/firebase/          admin (server) and client (browser) SDK setup
scripts/spike.mts      End-to-end chain check — run this first
examples/demo.py       The demo, in Python
firestore.rules        Per-user reads, deny-all writes
public/openapi.json    OpenAPI 3.1 spec
```

Built on [`@filoz/synapse-sdk`](https://github.com/FilOzone/synapse-sdk) v1.1, viem, wagmi and RainbowKit.
