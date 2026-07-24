'use client'

import {
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signOut as firebaseSignOut,
  type User,
} from 'firebase/auth'
import { useCallback, useEffect, useState } from 'react'

import { clientAuth, firebaseConfigured } from '@/lib/firebase/client'

export interface SluiceAuth {
  user: User | null
  loading: boolean
  error: string | null
  configured: boolean
  signInWithGoogle: () => Promise<void>
  signOut: () => Promise<void>
  /** Fresh ID token for calling the authenticated API routes. */
  token: () => Promise<string>
}

/** Google sign-in for the dashboard. Establishes identity only — spending rights are granted on-chain. */
export function useSluiceAuth(): SluiceAuth {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!firebaseConfigured) {
      setLoading(false)
      return
    }
    return onAuthStateChanged(clientAuth(), (next) => {
      setUser(next)
      setLoading(false)
    })
  }, [])

  const signInWithGoogle = useCallback(async () => {
    setError(null)
    try {
      const provider = new GoogleAuthProvider()
      await signInWithPopup(clientAuth(), provider)
    } catch (caught) {
      const code = (caught as { code?: string }).code ?? ''
      if (code.includes('popup-closed-by-user') || code.includes('cancelled-popup-request')) {
        // The user backed out; not worth an error banner.
        return
      }
      setError(
        code.includes('unauthorized-domain')
          ? 'This domain is not authorised in Firebase. Add it under Authentication → Settings → Authorized domains.'
          : code.includes('operation-not-allowed')
            ? 'Google sign-in is not enabled for this Firebase project.'
            : 'Sign-in failed. Check the Firebase configuration.'
      )
      throw caught
    }
  }, [])

  const signOut = useCallback(async () => {
    await firebaseSignOut(clientAuth())
  }, [])

  const token = useCallback(async () => {
    const current = clientAuth().currentUser
    if (current == null) throw new Error('Not signed in.')
    // Force-refresh: the API rejects stale tokens.
    return current.getIdToken(true)
  }, [])

  return { user, loading, error, configured: firebaseConfigured, signInWithGoogle, signOut, token }
}
