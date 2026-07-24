'use client'

import Link from 'next/link'
import { useCallback, useMemo } from 'react'

import { ApiKeys } from '@/components/dashboard/api-keys'
import { AuthorizationRow } from '@/components/dashboard/authorization-row'
import { OperatorGate } from '@/components/dashboard/operator-gate'
import { WalletSetup } from '@/components/dashboard/wallet-setup'
import { useAccount } from '@/hooks/use-account'
import { useAuthorizations, useVerifications } from '@/hooks/use-authorizations'
import { useSluiceAuth } from '@/hooks/use-sluice-auth'

export default function DashboardPage() {
  const auth = useSluiceAuth()

  if (auth.loading) {
    return (
      <Shell>
        <p className="font-mono text-xs text-white/40 mt-32 text-center">Loading…</p>
      </Shell>
    )
  }

  if (auth.user == null) {
    return (
      <Shell>
        <OperatorGate auth={auth} />
      </Shell>
    )
  }

  return (
    <Shell>
      <Console auth={auth} />
    </Shell>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return <main className="min-h-screen bg-black text-white px-6 lg:px-12 py-10">{children}</main>
}

function Console({ auth }: { auth: ReturnType<typeof useSluiceAuth> }) {
  const account = useAccount(auth)
  // Only this account's activity — one user must never see another's payments.
  const { rows, loading, error } = useAuthorizations(auth.user?.uid ?? null)
  const { rows: verifications } = useVerifications()

  const decide = useCallback(
    async (id: string, decision: 'approve' | 'reject') => {
      await account.api(`/api/v1/pay/approve/${id}`, {
        method: 'POST',
        body: JSON.stringify({ decision }),
      })
      // No local state update needed — the Firestore listener pushes the change.
    },
    [account]
  )

  const pending = useMemo(() => rows.filter((row) => row.status === 'pending_approval'), [rows])
  const executed = useMemo(() => rows.filter((row) => row.status === 'executed'), [rows])

  const totalSpent = useMemo(() => {
    const total = executed.reduce((sum, row) => sum + BigInt(row.amount?.raw ?? '0'), 0n)
    const whole = total / 10n ** 18n
    const fraction = (total % 10n ** 18n).toString().padStart(18, '0').slice(0, 4)
    return `${whole}.${fraction}`
  }, [executed])

  const approval = account.account?.operatorApproval ?? null

  return (
    <div className="max-w-[1400px] mx-auto">
      <header className="flex flex-wrap items-start justify-between gap-6 pb-8 border-b border-white/10">
        <div>
          <Link href="/" className="font-mono text-xs text-white/40 hover:text-white">
            ← sluice
          </Link>
          <h1 className="font-display text-4xl mt-3">Control room</h1>
          <p className="text-sm text-white/45 mt-2">
            Your Filecoin Pay account, the limits agents spend within, and every payment they made.
          </p>
        </div>
        <div className="text-right">
          <p className="font-mono text-[10px] text-white/40">{auth.user?.email}</p>
          <button onClick={() => auth.signOut()} className="font-mono text-[10px] text-white/40 hover:text-white mt-1">
            sign out
          </button>
        </div>
      </header>

      <section className="grid grid-cols-2 lg:grid-cols-4 gap-px bg-white/10 my-8">
        <Stat label="awaiting your approval" value={String(pending.length)} accent={pending.length > 0} />
        <Stat label="spent (USDFC)" value={totalSpent} />
        <Stat label="allowance left (USDFC)" value={remainingAllowance(approval)} />
        <Stat label="operator access" value={approval?.approved === true ? 'granted' : 'not granted'} />
      </section>

      <div className="grid gap-8 lg:grid-cols-2 mb-12">
        <WalletSetup account={account} />
        <ApiKeys account={account} />
      </div>

      {account.error != null && <p className="text-xs text-red-400 mb-8">{account.error}</p>}

      {pending.length > 0 && (
        <section className="mb-12">
          <h2 className="font-mono text-xs uppercase tracking-wider text-amber-300 mb-2">
            Held — waiting on you ({pending.length})
          </h2>
          <div className="border-b border-white/10">
            {pending.map((row) => (
              <AuthorizationRow key={row.id} authorization={row} onDecide={decide} />
            ))}
          </div>
        </section>
      )}

      <section className="mb-12">
        <h2 className="font-mono text-xs uppercase tracking-wider text-white/40 mb-2">Payment history</h2>
        {error != null && (
          <p className="text-xs text-red-400 py-4">
            {error} — check that firestore.rules and the composite indexes are deployed.
          </p>
        )}
        {loading && <p className="font-mono text-xs text-white/30 py-4">Loading…</p>}
        {!loading && rows.length === 0 && (
          <p className="font-mono text-xs text-white/30 py-6 border-t border-white/10">
            Nothing yet. Point an agent at POST /api/v1/pay/authorize to see it appear here live.
          </p>
        )}
        <div className="border-b border-white/10">
          {rows.map((row) => (
            <AuthorizationRow key={row.id} authorization={row} onDecide={decide} />
          ))}
        </div>
      </section>

      <section className="pb-16">
        <h2 className="font-mono text-xs uppercase tracking-wider text-white/40 mb-2">Recent proof checks</h2>
        {verifications.length === 0 && (
          <p className="font-mono text-xs text-white/30 py-6 border-t border-white/10">
            No verifications yet. Call GET /api/v1/verify/&lt;pieceCid&gt;.
          </p>
        )}
        {verifications.map((verification, index) => (
          <div
            key={`${verification.pieceCid}-${verification.checkedAt}-${index}`}
            className="border-t border-white/10 py-3 flex flex-wrap items-center gap-x-4 gap-y-1"
          >
            <span
              className={`font-mono text-[10px] uppercase tracking-wider border px-2 py-0.5 ${
                verification.status === 'healthy'
                  ? 'text-emerald-300 border-emerald-300/30'
                  : verification.status === 'stale'
                    ? 'text-red-400 border-red-400/30'
                    : 'text-white/40 border-white/15'
              }`}
            >
              {verification.status}
            </span>
            <span className="font-mono text-[11px] text-white/60 break-all">{verification.pieceCid}</span>
            <span className="font-mono text-[10px] text-white/30">
              last proven {verification.dataSetLastProven ?? 'never'}
            </span>
          </div>
        ))}
      </section>
    </div>
  )
}

/** How much of the on-chain grant is still spendable. */
function remainingAllowance(approval: { lockupAllowanceUsdfc: string; lockupUsageUsdfc: string } | null): string {
  if (approval == null) return '—'
  const toRaw = (value: string) => {
    const [whole, fraction = ''] = value.split('.')
    return BigInt(whole || '0') * 10n ** 18n + BigInt(fraction.padEnd(18, '0').slice(0, 18) || '0')
  }
  const remaining = toRaw(approval.lockupAllowanceUsdfc) - toRaw(approval.lockupUsageUsdfc)
  const whole = remaining / 10n ** 18n
  const fraction = (remaining % 10n ** 18n).toString().padStart(18, '0').slice(0, 4)
  return `${whole}.${fraction}`
}

function Stat({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="bg-black px-5 py-6">
      <p className={`font-display text-3xl ${accent ? 'text-amber-300' : 'text-white'}`}>{value}</p>
      <p className="font-mono text-[10px] text-white/35 mt-1">{label}</p>
    </div>
  )
}
