import { initializeApp, getApps, getApp } from 'firebase/app';
import { initializeAuth, getAuth, getReactNativePersistence, type Auth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import AsyncStorage from '@react-native-async-storage/async-storage';

const firebaseConfig = {
  apiKey:            process.env.EXPO_PUBLIC_FIREBASE_API_KEY             ?? '',
  authDomain:        process.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN         ?? '',
  projectId:         process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID          ?? '',
  storageBucket:     process.env.EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET      ?? '',
  messagingSenderId: process.env.EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID ?? '',
  appId:             process.env.EXPO_PUBLIC_FIREBASE_APP_ID              ?? '',
};

const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();

let auth: Auth;
try {
  auth = initializeAuth(app, {
    persistence: getReactNativePersistence(AsyncStorage),
  });
} catch (e: unknown) {
  const msg = e instanceof Error ? e.message : '';
  if (!msg.includes('already-initialized')) throw e;
  auth = getAuth(app);
}

const db = getFirestore(app);

export { app, auth, db };
