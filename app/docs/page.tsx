import Link from 'next/link'
import type { Metadata } from 'next'

import { CodeBlock } from '@/components/docs/code-block'

export const metadata: Metadata = {
  title: 'Sluice — API reference',
  description:
    'REST access to Filecoin Onchain Cloud payments and PDP proof status. Agents spend from your own account within limits you set on-chain, and anything above your cap waits for you.',
}

const CURL_VERIFY = `curl https://your-sluice.vercel.app/api/v1/verify/bafkzcibcd4bdomn3tgwgrh3g532zopskstnbrd2n3sxfqbppqmw2vpv3g7dtoq

{
  "pieceCid": "bafkzcibcd4bdomn...",
  "dataSetId": "42",
  "healthy": true,
  "status": "healthy",
  "dataSetLastProven": "2026-07-24T09:12:00.000Z",
  "dataSetNextProofDue": "2026-07-24T21:12:00.000Z",
  "isProofOverdue": false,
  "inChallengeWindow": false,
  "retrievalUrl": "https://...",
  "pieceId": "3"
}`

const CURL_AUTHORIZE = `curl -X POST https://your-sluice.vercel.app/api/v1/pay/authorize \
  -H "Authorization: Bearer sluice_sk_..." \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: run-42-payment" \
  -d '{"kind": "pay", "to": "0xRecipient...", "amount": "0.25"}'`

const GRANT = `// What you sign once, in the browser, from your own wallet.
// After this an agent can spend — but only within these numbers,
// and the contract, not Sluice, is what enforces them.

setOperatorApproval(
  USDFC,
  sluiceOperatorAddress,
  true,
  rateAllowance,     // max USDFC per epoch
  lockupAllowance,   // max USDFC ever committed  <- the real ceiling
  maxLockupPeriod
)

// Revoke at any time:
setOperatorApproval(USDFC, sluiceOperatorAddress, false, 0, 0, 0)`

const PY_DEMO = `import os, time, requests

SLUICE = os.environ["SLUICE_URL"]
AUTH = {"Authorization": f"Bearer {os.environ['SLUICE_API_KEY']}"}

def authorize(payload, idempotency_key=None):
    headers = dict(AUTH)
    if idempotency_key:
        headers["Idempotency-Key"] = idempotency_key
    r = requests.post(f"{SLUICE}/api/v1/pay/authorize", json=payload, headers=headers)
    r.raise_for_status()
    return r.json()["authorization"]

def wait(auth_id, timeout=600):
    """Block until terminal.

    A 202 means the account owner has to approve first, so this can
    legitimately sit here for minutes. Poll politely.
    """
    deadline = time.time() + timeout
    while time.time() < deadline:
        r = requests.get(f"{SLUICE}/api/v1/pay/status/{auth_id}", headers=AUTH)
        r.raise_for_status()
        a = r.json()["authorization"]
        if not a["pending"]:
            return a
        time.sleep(3)
    raise TimeoutError(f"{auth_id} still pending after {timeout}s")

PAYEE = "0xRecipient..."

# 1. Under the cap: executes immediately.
small = authorize({"kind": "pay", "to": PAYEE, "amount": "0.25"})
print(small["status"], small.get("txHash"))

# Keep the rail id — reusing it saves a transaction next time.
rail = (small.get("result") or {}).get("reusableRailId")

# 2. Over the cap: held until the account owner approves.
big = authorize({"kind": "pay", "to": PAYEE, "amount": "12.0", "railId": rail})
print(big["status"])          # pending_approval
final = wait(big["id"])
print(final["status"], final.get("explorerUrl"))

# 3. Verify a stored piece — no key needed for this one.
piece = requests.get(f"{SLUICE}/api/v1/verify/bafkzcib...").json()
print(piece["status"], piece["dataSetLastProven"])`

const KINDS = `# One-time payment. Creates a rail if you do not name one.
{"kind": "pay", "to": "0xRecipient...", "amount": "0.5"}

# Reuse the rail from a previous payment — saves a transaction.
{"kind": "pay", "to": "0xRecipient...", "amount": "0.5", "railId": "17"}

# Change a rail's streaming rate (USDFC per epoch).
{"kind": "modify_rate", "railId": "17", "ratePerEpoch": "0.001"}

# Close a rail.
{"kind": "terminate_rail", "railId": "17"}

# Store data in Warm Storage; returns a PieceCID for /verify.
{"kind": "store", "dataBase64": "aGVsbG8gZmlsZWNvaW4=", "label": "run-42"}`

const N8N = `{
  "method": "POST",
  "url": "https://your-sluice.vercel.app/api/v1/pay/authorize",
  "authentication": "genericCredentialType",
  "genericAuthType": "httpHeaderAuth",
  "sendHeaders": true,
  "headerParameters": {
    "parameters": [
      { "name": "Idempotency-Key", "value": "={{ $execution.id }}" }
    ]
  },
  "sendBody": true,
  "specifyBody": "json",
  "jsonBody": "={{ JSON.stringify({ kind: 'pay', to: '0xRecipient...', amount: '0.25' }) }}"
}`

const ERRORS = `401 unauthorized       Missing or unknown API key
403 forbidden          Key revoked, operator access not granted or revoked,
                       or out of on-chain allowance
404 not_found          No such authorization (or it belongs to another key)
409 conflict           Idempotency-Key reused with a different body,
                       or the request is no longer awaiting approval
429 too_many_requests  Daily budget exhausted, or another payment is
                       mid-signature — retry in a few seconds
502 upstream_error     The chain or a storage provider rejected the call`

export default function DocsPage() {
  return (
    <main className="min-h-screen bg-black text-white">
      <div className="max-w-3xl mx-auto px-6 py-16 lg:py-24">
        <Link href="/" className="font-mono text-xs text-white/40 hover:text-white">
          ← sluice
        </Link>

        <h1 className="font-display text-5xl lg:text-6xl mt-6 leading-[0.95]">API reference</h1>
        <p className="text-white/55 mt-6 leading-relaxed text-lg">
          REST access to Filecoin Onchain Cloud on the Calibration testnet. Sluice never holds your
          private key — you keep your USDFC in your own Filecoin Pay account and grant Sluice bounded
          operator rights on-chain. Amounts are decimal USDFC strings, never floats.
        </p>

        <Callout>
          Testnet only. You need tFIL for gas and tUSDFC to spend, both from public faucets, before
          anything here will work.
        </Callout>

        <Section id="auth" title="Two gates, and how they differ">
          <p>
            Sluice sits behind <strong>two independent limits</strong>, and it is worth knowing which
            one you are hitting.
          </p>
          <ul className="list-none space-y-3 my-6 text-white/60">
            <li className="flex gap-3">
              <span className="font-mono text-xs mt-1 shrink-0 text-white/40">1</span>
              <span>
                <strong className="text-white/80">Your API key cap</strong> — enforced by Sluice. Under
                it, a request executes immediately. Over it, the request is held and you decide.
              </span>
            </li>
            <li className="flex gap-3">
              <span className="font-mono text-xs mt-1 shrink-0 text-white/40">2</span>
              <span>
                <strong className="text-white/80">Your on-chain operator allowance</strong> — enforced by
                the Filecoin Pay contract, not by Sluice. This is the hard ceiling on everything Sluice
                can ever commit, and no bug on our side can exceed it.
              </span>
            </li>
          </ul>
          <p>
            The grant that creates the second limit is a single transaction you sign in the dashboard:
          </p>
          <CodeBlock lang="solidity" code={GRANT} />
          <p className="mt-6">
            Crucially, <Mono>withdraw</Mono> and <Mono>withdrawTo</Mono> revert with{' '}
            <Mono>CallerNotPayer</Mono>. An operator can direct your funds through payment rails but can
            never pull them out to itself.
          </p>
          <p>
            Agents authenticate with <Mono>Authorization: Bearer sluice_sk_…</Mono>. Keys are stored
            hashed and are minted from the dashboard.{' '}
            <Mono>GET /verify/:pieceCid</Mono>, <Mono>/health</Mono> and <Mono>/stats</Mono> need no key
            at all — they are read-only and spend nothing.
          </p>
        </Section>

        <Section id="authorize" title="POST /api/v1/pay/authorize">
          <p>
            The gate. Sluice prices the request against the chain <em>before</em> anything is signed,
            then compares it to your key&apos;s cap.
          </p>
          <ul className="list-none space-y-2 my-6 text-white/60">
            <li className="flex gap-3">
              <span className="font-mono text-emerald-300 text-xs mt-1 shrink-0">200</span>
              <span>Under the cap. Already broadcast; the response carries the transaction hash.</span>
            </li>
            <li className="flex gap-3">
              <span className="font-mono text-amber-300 text-xs mt-1 shrink-0">202</span>
              <span>
                Over the cap. Held as <Mono>pending_approval</Mono>. Nothing has been signed — poll{' '}
                <Mono>/pay/status/:id</Mono>.
              </span>
            </li>
          </ul>
          <CodeBlock lang="bash" code={CURL_AUTHORIZE} />
          <p className="mt-6">
            Pass <Mono>Idempotency-Key</Mono> on anything you might retry. A replay returns the original
            authorization instead of paying twice; reusing a key with a different body is a{' '}
            <Mono>409</Mono>.
          </p>
        </Section>

        <Section id="kinds" title="Payment kinds">
          <p>
            Filecoin Pay is rail-based rather than peer-to-peer, so a payment opens a channel and then
            moves a lump sum through it. Sluice does this as your operator, in one call.
          </p>
          <CodeBlock lang="json" code={KINDS} />
          <p className="mt-6 text-white/50 text-sm">
            The first payment to a recipient creates a rail and costs an extra transaction. Keep the{' '}
            <Mono>reusableRailId</Mono> from the response and pass it as <Mono>railId</Mono> next time.
          </p>
        </Section>

        <Section id="status" title="GET /api/v1/pay/status/:id">
          <p>
            The polling endpoint. Also where a broadcast transaction gets confirmed and a stale request
            gets expired, so your poll loop drives the whole lifecycle. Watch the{' '}
            <Mono>pending</Mono> boolean and stop when it goes false.
          </p>
        </Section>

        <Section id="approve" title="POST /api/v1/pay/approve/:id">
          <p>
            The human side. Requires the Firebase ID token of the account whose funds are at stake — an
            API key is deliberately not enough, since the agent being gated must not be able to release
            its own payment. In practice you click the button in the{' '}
            <Link href="/dashboard" className="text-white underline underline-offset-4">
              control room
            </Link>
            .
          </p>
          <p>
            Body: <Mono>{'{ "decision": "approve" }'}</Mono> or <Mono>{'{ "decision": "reject" }'}</Mono>.
          </p>
        </Section>

        <Section id="wallet-actions" title="What the API deliberately cannot do">
          <p>
            <Mono>deposit</Mono>, <Mono>withdraw</Mono>, <Mono>settle</Mono>, and granting or revoking
            operator access are <strong>not</strong> available over REST. This is not a policy choice:
            Filecoin Pay restricts them to the account holder, so Sluice could not perform them for you
            even if it wanted to.
          </p>
          <p>
            They live in the dashboard, signed by your own wallet. Asking for one over REST returns a{' '}
            <Mono>400</Mono> that says so.
          </p>
        </Section>

        <Section id="verify" title="GET /api/v1/verify/:pieceCid">
          <p>
            PDP proof status as plain JSON. No wallet, no key, no SDK. Proofs are submitted per data set
            rather than per piece, so the timestamps describe the data set containing the piece.
          </p>
          <CodeBlock lang="bash" code={CURL_VERIFY} />
          <p className="mt-6">
            This takes a <strong>PieceCID</strong> (<Mono>bafkzc…</Mono>), not an IPFS CID. You get one
            back from a <Mono>store</Mono> authorization. Add <Mono>?client=0x…</Mono> to check data sets
            owned by another address; it defaults to the gateway&apos;s own wallet.
          </p>
        </Section>

        <Section id="python" title="Full example — Python">
          <p>No JS runtime, no wallet handling, no SDK. Just requests.</p>
          <CodeBlock lang="python" code={PY_DEMO} />
        </Section>

        <Section id="n8n" title="No-code — n8n HTTP node">
          <p>
            Header auth with your Sluice key, and the execution id as the idempotency key so a
            re-run never double-pays.
          </p>
          <CodeBlock lang="json" code={N8N} />
        </Section>

        <Section id="errors" title="Errors">
          <p>
            Every failure returns <Mono>{'{ "error": { "code", "message" } }'}</Mono>. Branch on{' '}
            <Mono>code</Mono> — it is stable; the message is not.
          </p>
          <CodeBlock code={ERRORS} />
        </Section>

        <footer className="mt-20 pt-8 border-t border-white/10 flex flex-wrap gap-6 font-mono text-xs text-white/30">
          <Link href="/dashboard" className="hover:text-white">
            control room
          </Link>
          <a href="/api/v1/health" className="hover:text-white">
            health
          </a>
          <a href="/openapi.json" className="hover:text-white">
            openapi.json
          </a>
          <a href="https://docs.filecoin.cloud" className="hover:text-white">
            filecoin onchain cloud ↗
          </a>
        </footer>
      </div>
    </main>
  )
}

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="mt-16 scroll-mt-8">
      <h2 className="font-display text-2xl lg:text-3xl mb-4">{title}</h2>
      <div className="space-y-4 text-white/60 leading-relaxed">{children}</div>
    </section>
  )
}

function Mono({ children }: { children: React.ReactNode }) {
  return <code className="font-mono text-[13px] text-white/85 bg-white/[0.06] px-1.5 py-0.5">{children}</code>
}

function Callout({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-8 border-l-2 border-amber-300/40 bg-amber-300/[0.04] px-4 py-3 text-sm text-amber-100/70">
      {children}
    </p>
  )
}
