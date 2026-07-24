'use client'

import { getApp, getApps, initializeApp, type FirebaseApp } from 'firebase/app'
import { getAuth, type Auth } from 'firebase/auth'
import { getFirestore, type Firestore } from 'firebase/firestore'

/**
 * Browser-side Firebase.
 *
 * These values are public by design — they identify the project, they do not
 * authorise anything. Access is decided by firestore.rules, which grants the
 * dashboard read-only access and denies every client write.
 */
const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
}

/** True when the dashboard has enough config to connect. Lets the UI explain itself instead of crashing. */
export const firebaseConfigured =
  firebaseConfig.apiKey != null && firebaseConfig.projectId != null && firebaseConfig.appId != null

function app(): FirebaseApp {
  if (!firebaseConfigured) {
    throw new Error(
      'Firebase is not configured. Set the NEXT_PUBLIC_FIREBASE_* variables — see .env.example.'
    )
  }
  return getApps().length > 0 ? getApp() : initializeApp(firebaseConfig)
}

export function clientAuth(): Auth {
  return getAuth(app())
}

export function clientDb(): Firestore {
  return getFirestore(app())
}
