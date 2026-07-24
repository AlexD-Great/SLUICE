'use client'

import type { SluiceAuth } from '@/hooks/use-sluice-auth'

/** Sign-in wall. Identity only — what you may spend is decided on-chain, later. */
export function OperatorGate({ auth }: { auth: SluiceAuth }) {
  if (!auth.configured) {
    return (
      <div className="max-w-md mx-auto mt-32 border border-white/10 p-8">
        <h1 className="font-display text-2xl text-white mb-3">Firebase not configured</h1>
        <p className="text-sm text-white/50 leading-relaxed">
          Set the <span className="font-mono text-white/70">NEXT_PUBLIC_FIREBASE_*</span> variables in{' '}
          <span className="font-mono text-white/70">.env.local</span> and restart. See{' '}
          <span className="font-mono text-white/70">.env.example</span>.
        </p>
      </div>
    )
  }

  return (
    <div className="max-w-md mx-auto mt-32 border border-white/10 p-8">
      <span className="font-mono text-xs text-white/40">Sluice</span>
      <h1 className="font-display text-3xl text-white mt-3 mb-2">Sign in</h1>
      <p className="text-sm text-white/50 mb-8 leading-relaxed">
        Connect an account, link your wallet, and set the limits your agents spend within. Sluice never
        holds your private key.
      </p>

      <button
        onClick={() => auth.signInWithGoogle().catch(() => {})}
        className="w-full bg-white text-black py-3 text-sm font-medium hover:bg-white/90 flex items-center justify-center gap-3"
      >
        <GoogleMark />
        Continue with Google
      </button>

      {auth.error != null && <p className="text-sm text-red-400 mt-4">{auth.error}</p>}

      <p className="font-mono text-[10px] text-white/25 mt-8 leading-relaxed">
        Filecoin Calibration testnet. You will need tFIL for gas and tUSDFC to spend, both from public
        faucets.
      </p>
    </div>
  )
}

function GoogleMark() {
  return (
    <svg viewBox="0 0 24 24" className="w-4 h-4" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.5h6.5a5.6 5.6 0 0 1-2.4 3.7v3h3.9c2.3-2.1 3.5-5.2 3.5-8.9z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.2 0 5.9-1.1 7.9-2.9l-3.9-3c-1.1.7-2.4 1.2-4 1.2-3.1 0-5.7-2.1-6.6-4.9H1.4v3.1A12 12 0 0 0 12 24z"
      />
      <path fill="#FBBC05" d="M5.4 14.4a7.2 7.2 0 0 1 0-4.6V6.7H1.4a12 12 0 0 0 0 10.8l4-3.1z" />
      <path
        fill="#EA4335"
        d="M12 4.8c1.8 0 3.4.6 4.6 1.8l3.4-3.4A12 12 0 0 0 1.4 6.7l4 3.1C6.3 6.9 8.9 4.8 12 4.8z"
      />
    </svg>
  )
}
