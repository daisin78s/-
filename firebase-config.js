/** Firebase project config (2026-08-29, for online multiplayer + cloud ranking/replay -- see the
 * "オンライン対戦 + ランキング/リプレイのクラウド共有" plan). Plain classic <script>, same convention as
 * ranking.js/main.js -- not run under Node tests, browser-only. Exposes window.FIREBASE_CONFIG.
 *
 * This object is NOT a secret -- Firebase's own docs confirm the client config (apiKey included) is
 * safe to ship in public client-side code; access control is enforced by Firestore/Storage Security
 * Rules on the server side, not by hiding this object. Safe to commit to the repo.
 *
 * HOW TO FILL THIS IN:
 * 1. https://firebase.google.com/ -> sign in -> create a project
 * 2. Console sidebar -> Firestore Database -> create database (test mode is fine to start)
 * 3. Console sidebar -> Storage -> enable (requires upgrading to the Blaze pay-as-you-go plan -- a
 *    credit card, but actual usage stays within the free quota for this app's scale)
 * 4. Project settings (gear icon) -> "General" tab -> "Your apps" -> add a Web app (</> icon) -- no
 *    need to check "Also set up Firebase Hosting"
 * 5. Copy the `firebaseConfig = { apiKey: "...", ... }` object shown there into FIREBASE_CONFIG below,
 *    replacing every placeholder string.
 */
window.FIREBASE_CONFIG = {
  apiKey: 'AIzaSyDWalYNiQ-_wxdmupplZM6qeLflPPI1KdQ',
  authDomain: 'dice-wp.firebaseapp.com',
  projectId: 'dice-wp',
  storageBucket: 'dice-wp.firebasestorage.app',
  messagingSenderId: '73480853324',
  appId: '1:73480853324:web:3ed047bfd00f32dd80a1e9',
  measurementId: 'G-TBFNBCZDLZ',
};
