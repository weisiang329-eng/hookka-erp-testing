// ---------------------------------------------------------------------------
// Hookka Worker Portal — iOS shell config.
//
// Shop-floor app: punch in/out (with selfie + soft geofence), scan job-card QR,
// view pay. Wraps the live /worker PWA — see mobile/README.md for WHY it loads
// the live URL instead of a bundled copy (cookie auth must stay same-origin).
// ---------------------------------------------------------------------------
import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.hookka.worker",
  appName: "Hookka Worker",

  // Local bundle used ONLY when the live URL can't be reached (see offline/).
  webDir: "offline",

  server: {
    url: "https://erp.hookka.com/worker",
    // Never allow plaintext — the session cookie rides these requests.
    cleartext: false,
    // Keep navigation inside our own origin; anything else opens in Safari
    // rather than inside the app shell.
    allowNavigation: ["erp.hookka.com"],
  },

  ios: {
    // Opaque background avoids a white flash before the site paints.
    backgroundColor: "#1F1D1B",
    // The web app manages its own safe-area padding (theme-vars.css), so let
    // the webview run edge-to-edge rather than double-insetting.
    contentInset: "never",
    // The shop floor scans constantly; keep the scroll bounce off so a
    // mis-swipe during a scan doesn't drag the page.
    scrollEnabled: true,
    limitsNavigationsToAppBoundDomains: true,
  },

  plugins: {
    SplashScreen: {
      launchShowDuration: 1200,
      backgroundColor: "#1F1D1B",
      showSpinner: false,
      launchAutoHide: true,
    },
    PushNotifications: {
      // Punch reminders / job-card assignments. Registration is requested by
      // the web layer via src/lib/native, not automatically on launch.
      presentationOptions: ["badge", "sound", "alert"],
    },
  },
};

export default config;
