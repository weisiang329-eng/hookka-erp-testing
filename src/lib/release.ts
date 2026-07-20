declare const __APP_VERSION__: string;
declare const __RELEASE_ID__: string;
declare const __RELEASE_CHANNEL__: string;
declare const __BUILD_BRANCH__: string;
declare const __BUILD_SHA__: string;
declare const __SCHEMA_VERSION__: string;

export const RELEASE = Object.freeze({
  // The typeof guards keep direct Node/tsx unit tests usable outside Vite.
  // Real builds replace every constant at compile time.
  version: typeof __APP_VERSION__ === "undefined" ? "0.0.0-test" : __APP_VERSION__,
  releaseId: typeof __RELEASE_ID__ === "undefined" ? "0.0.0-test+unknown" : __RELEASE_ID__,
  channel: typeof __RELEASE_CHANNEL__ === "undefined" ? "test" : __RELEASE_CHANNEL__,
  branch: typeof __BUILD_BRANCH__ === "undefined" ? "test" : __BUILD_BRANCH__,
  commitSha: typeof __BUILD_SHA__ === "undefined" ? "unknown" : __BUILD_SHA__,
  schemaVersion: typeof __SCHEMA_VERSION__ === "undefined" ? "untracked" : __SCHEMA_VERSION__,
});

export type ReleaseMetadata = typeof RELEASE;
