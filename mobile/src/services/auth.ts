import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut as firebaseSignOut,
  onAuthStateChanged as firebaseOnAuthStateChanged,
  sendPasswordResetEmail,
  type User,
} from 'firebase/auth';
import { auth } from './firebase';

export async function signUpWithEmail(email: string, password: string): Promise<User> {
  const result = await createUserWithEmailAndPassword(auth, email, password);
  return result.user;
}

export async function signInWithEmail(email: string, password: string): Promise<User> {
  const result = await signInWithEmailAndPassword(auth, email, password);
  return result.user;
}

export async function signOut(): Promise<void> {
  await firebaseSignOut(auth);
}

export function onAuthStateChanged(cb: (user: User | null) => void): () => void {
  return firebaseOnAuthStateChanged(auth, cb);
}

export function getCurrentUserId(): string | null {
  return auth.currentUser?.uid ?? null;
}

export async function resetPassword(email: string): Promise<void> {
  await sendPasswordResetEmail(auth, email);
}
