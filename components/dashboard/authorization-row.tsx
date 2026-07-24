'use client'

import { useState } from 'react'

import type { Authorization, AuthStatus } from '@/lib/sluice/types'

const STATUS_STYLES: Record<AuthStatus, { label: string; className: string }> = {
  pending: { label: 'executing', className: 'text-amber-300 border-amber-300/30' },
  pending_approval: { label: 'awaiting approval', className: 'text-amber-300 border-amber-300/40' },
  approved: { label: 'approved', className: 'text-cyan-300 border-cyan-300/30' },
  executing: { label: 'confirming', className: 'text-cyan-300 border-cyan-300/30' },
  executed: { label: 'executed', className: 'text-emerald-300 border-emerald-300/30' },
  rejected: { label: 'rejected', className: 'text-white/40 border-white/15' },
  failed: { label: 'failed', className: 'text-red-400 border-red-400/30' },
  expired: { label: 'expired', className: 'text-white/40 border-white/15' },
}

const KIND_LABELS: Record<string, string> = {
  deposit: 'Deposit to Filecoin Pay',
  withdraw: 'Withdraw from escrow',
  approve_service: 'Raise Warm Storage allowance',
  settle: 'Settle payment rail',
  store: 'Store data (Warm Storage)',
}

function timeAgo(ms: number): string {
  const seconds = Math.round((Date.now() - ms) / 1000)
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`
  return `${Math.round(seconds / 3600)}h ago`
}

export function AuthorizationRow({
  authorization,
  onDecide,
}: {
  authorization: Authorization
  onDecide: (id: string, decision: 'approve' | 'reject') => Promise<void>
}) {
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const status = STATUS_STYLES[authorization.status] ?? STATUS_STYLES.pending
  const awaiting = authorization.status === 'pending_approval'

  async function decide(decision: 'approve' | 'reject') {
    setBusy(decision)
    setError(null)
    try {
      await onDecide(authorization.id, decision)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div
      className={`border-t border-white/10 py-5 px-1 ${awaiting ? 'bg-amber-300/[0.03]' : ''}`}
      data-testid="authorization-row"
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-3 flex-wrap">
            <span className={`font-mono text-[10px] uppercase tracking-wider border px-2 py-0.5 ${status.className}`}>
              {status.label}
            </span>
            <span className="text-white text-sm">{KIND_LABELS[authorization.kind] ?? authorization.kind}</span>
            {authorization.autoApproved && (
              <span className="font-mono text-[10px] text-white/30">under cap · auto</span>
            )}
          </div>

          <div className="mt-2 flex items-baseline gap-2">
            <span className="font-display text-2xl text-white">{authorization.amount.usdfc}</span>
            <span className="font-mono text-xs text-white/40">USDFC</span>
            <span className="font-mono text-[10px] text-white/30">
              cap {authorization.capUsdfc} · {authorization.amount.basis.replace(/_/g, ' ')}
            </span>
          </div>

          {authorization.amount.note != null && (
            <p className="mt-2 text-xs text-white/45 leading-relaxed max-w-xl">{authorization.amount.note}</p>
          )}

          <div className="mt-3 font-mono text-[10px] text-white/30 flex flex-wrap gap-x-4 gap-y-1">
            <span>{authorization.apiKeyLabel}</span>
            <span>{timeAgo(authorization.createdAt)}</span>
            {authorization.decidedByEmail != null && <span>decided by {authorization.decidedByEmail}</span>}
            {authorization.result?.pieceCid != null && (
              <span className="text-white/50 break-all">piece {String(authorization.result.pieceCid)}</span>
            )}
          </div>

          {authorization.error != null && <p className="mt-2 text-xs text-red-400">{authorization.error}</p>}
          {error != null && <p className="mt-2 text-xs text-red-400">{error}</p>}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {authorization.explorerUrl != null && (
            <a
              href={authorization.explorerUrl}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-[10px] text-white/40 hover:text-white border border-white/10 px-3 py-1.5"
            >
              explorer ↗
            </a>
          )}
          {awaiting && (
            <>
              <button
                onClick={() => decide('reject')}
                disabled={busy != null}
                className="font-mono text-[10px] uppercase tracking-wider border border-white/15 text-white/60 px-4 py-1.5 hover:border-white/40 hover:text-white disabled:opacity-40"
              >
                {busy === 'reject' ? '…' : 'Reject'}
              </button>
              <button
                onClick={() => decide('approve')}
                disabled={busy != null}
                className="font-mono text-[10px] uppercase tracking-wider bg-white text-black px-4 py-1.5 hover:bg-white/90 disabled:opacity-40"
              >
                {busy === 'approve' ? 'Releasing…' : 'Approve'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
