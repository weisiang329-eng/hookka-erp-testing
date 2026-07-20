// ---------------------------------------------------------------------------
// Hookka ERP — iOS shell config (office mobile).
//
// Wraps the live /m PWA: production, sales, warehouse, service cases, mail,
// announcements. Same loading strategy and reasoning as the worker shell —
// see mobile/README.md.
// ---------------------------------------------------------------------------
import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.hookka.erp",
  appName: "Hookka ERP",

  webDir: "offline",

  server: {
    url: "https://erp.hookka.com/m",
    cleartext: false,
    allowNavigation: ["erp.hookka.com"],
  },

  ios: {
    backgroundColor: "#1F1D1B",
    contentInset: "never",
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
      // The office value: new order / overdue / approval-needed alerts.
      presentationOptions: ["badge", "sound", "alert"],
    },
  },
};

export default config;
