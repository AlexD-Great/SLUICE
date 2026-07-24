'use client'

import { collection, limit, onSnapshot, orderBy, query, where } from 'firebase/firestore'
import { useEffect, useState } from 'react'

import { clientDb } from '@/lib/firebase/client'
import type { Authorization, VerificationResult } from '@/lib/sluice/types'

/**
 * Live payment feed for one account.
 *
 * A Firestore listener rather than polling: approving in one tab updates every
 * other viewer immediately, which is exactly what the demo needs to show.
 *
 * Scoped to `ownerUid` — matching the security rule, so the query is not merely
 * a convenience but the only shape the rules will allow.
 */
export function useAuthorizations(
  ownerUid: string | null,
  max = 50
): { rows: Authorization[]; loading: boolean; error: string | null } {
  const [rows, setRows] = useState<Authorization[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (ownerUid == null) {
      setRows([])
      setLoading(false)
      return
    }

    const q = query(
      collection(clientDb(), 'authorizations'),
      where('ownerUid', '==', ownerUid),
      orderBy('createdAt', 'desc'),
      limit(max)
    )
    return onSnapshot(
      q,
      (snapshot) => {
        setRows(snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }) as Authorization))
        setLoading(false)
      },
      (caught) => {
        setError(caught.message)
        setLoading(false)
      }
    )
  }, [ownerUid, max])

  return { rows, loading, error }
}

/** Live feed of proof checks, for the verification panel. */
export function useVerifications(max = 20): { rows: VerificationResult[]; loading: boolean } {
  const [rows, setRows] = useState<VerificationResult[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const q = query(collection(clientDb(), 'verifications'), orderBy('checkedAt', 'desc'), limit(max))
    return onSnapshot(
      q,
      (snapshot) => {
        setRows(snapshot.docs.map((doc) => doc.data() as VerificationResult))
        setLoading(false)
      },
      () => setLoading(false)
    )
  }, [max])

  return { rows, loading }
}
