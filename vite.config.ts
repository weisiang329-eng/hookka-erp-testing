import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
import { getReleaseMetadata } from './scripts/lib/release-metadata.mjs'

const release = getReleaseMetadata({ rootDir: __dirname })

function releaseManifest(): Plugin {
  return {
    name: 'hookka-release-manifest',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'version.json',
        source: `${JSON.stringify(release, null, 2)}\n`,
      })
    },
  }
}

// ───────────────────────────────────────────────────────────────────────────
// stripCrossorigin — remove the `crossorigin` attribute Vite stamps onto every
// emitted <script type=module> + <link rel=stylesheet/modulepreload> in
// index.html.
//
// Why: our assets are SAME-ORIGIN (erp.hookka.com page loads
// erp.hookka.com/assets/*), so crossorigin is unnecessary. But it forces the
// browser into CORS mode for those requests, and during the 2026-05-27
// custom-domain cutover there was a window where /assets/* lacked an
// Access-Control-Allow-Origin header. Browsers that loaded the page in that
// window cached an OPAQUE (CORS-failed) copy of the CSS/JS. Even after the
// ACAO:* header was restored, those browsers keep serving the stale opaque
// cache for the crossorigin request → the stylesheet loads (200) but the
// browser refuses to apply it → fully-unstyled page (BUG-2026-05-28-004).
//
// Removing crossorigin makes the browser fetch same-origin assets in plain
// no-cors mode, which can never enter the opaque-cache failure state. Costs
// nothing (subresource integrity isn't used here).
// ───────────────────────────────────────────────────────────────────────────
function stripCrossorigin(): Plugin {
  return {
    name: 'strip-crossorigin',
    enforce: 'post',
    transformIndexHtml(html) {
      return html.replace(/\s+crossorigin(?:=["'][^"']*["'])?/g, '')
    },
  }
}

// Plain HTTP dev server. Live-camera scanning (getUserMedia) is gated by
// the browser to HTTPS or localhost — on LAN phones it fails silently.
// Workers use the Upload photos path instead (multiple select + batch
// queue), which works fine over HTTP.
export default defineConfig({
  // Deterministic release identity. The previous Date.now() value changed on
  // every rebuild of the same commit, so logs, caches and deployed artifacts
  // could not be correlated. SemVer + channel + SHA stays unique per deploy
  // while identical source produces the same identity.
  define: {
    __APP_VERSION__: JSON.stringify(release.version),
    __RELEASE_ID__: JSON.stringify(release.releaseId),
    __RELEASE_CHANNEL__: JSON.stringify(release.channel),
    __BUILD_BRANCH__: JSON.stringify(release.branch),
    __BUILD_SHA__: JSON.stringify(release.commitSha),
    __SCHEMA_VERSION__: JSON.stringify(release.schemaVersion),
    __BUILD_ID__: JSON.stringify(release.releaseId),
  },
  plugins: [react(), tailwindcss(), stripCrossorigin(), releaseManifest()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    // ─────────────────────────────────────────────────────────────────
    // Module-preload filter (perf, 2026-05-12 — Wei Siang report).
    //
    // Rolldown's default `modulePreload` emits a
    // `<link rel="modulepreload" href="…">` tag in index.html for every
    // chunk reachable from the entry, including heavy chunks that we
    // ONLY load behind `await import()` at click time (pdf-lib /
    // pdfjs-dist / jspdf for invoice/DO/quotation generation, xlsx for
    // Excel import-export). Without filtering, the browser eagerly
    // downloads ~1.5 MB of JS on every cold visit — even on Dashboard,
    // where neither library is touched — pushing first-byte-to-interactive
    // up by ~700ms on a typical broadband connection.
    //
    // The `resolveDependencies` hook below removes any chunk filename
    // matching /pdf-|xlsx-|charts-/ from the preload list. The chunks still
    // exist on disk and are loaded by the dynamic-import call sites the
    // moment a user clicks Export-Excel / Generate-PDF / Scan-PO; we
    // just don't pay for them on every page transition any more.
    //
    // Caveat: dynamic chunks are no longer warm in the HTTP cache until
    // their first use, so the first Generate-Invoice-PDF click after a
    // deploy pays a ~300ms download. That's an acceptable trade — the
    // savings on every other page transition far outweigh it.
    // ─────────────────────────────────────────────────────────────────
    modulePreload: {
      resolveDependencies(_filename, deps) {
        return deps.filter((d) => !/(^|\/)(pdf|xlsx|charts)-[A-Za-z0-9_-]+\.js$/.test(d));
      },
    },
    // Vite 8 uses Rolldown (https://vite.dev/guide/migration.html). Its legacy manualChunks compatibility layer
    // recursively captures dependencies into a named group; that made the
    // global entry statically import page-only charts/PDF code. Native
    // codeSplitting groups keep those heavy libraries behind their import()
    // boundaries while retaining stable, reviewable vendor chunk names.
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
          // Split react-vendor into 3 parallel chunks (owner 2026-06-29: the
          // single 87 KB react-vendor took 38 s on a flaky factory wifi
          // because all of React had to arrive before paint).
          //   • react-core   = react + scheduler (small, ~10 KB)
          //   • react-dom    = the bulk of the runtime (~75 KB)
          //   • react-router = routing only (~10 KB)
          // On HTTP/2 all 3 stream in parallel; if one stalls the other 2
          // can still finish, and React can boot the moment react-core +
          // react-dom both arrive — router can land slightly after.
            {
              name: 'react-core',
              test: /node_modules[\\/](?:react|scheduler)[\\/]/,
              priority: 100,
            },
            {
              name: 'react-dom',
              test: /node_modules[\\/]react-dom[\\/]/,
              priority: 100,
            },
            {
              name: 'react-router',
              test: /node_modules[\\/]react-router(?:-dom)?[\\/]/,
              priority: 100,
            },
            {
              name: 'charts',
              test: /node_modules[\\/](?:recharts|d3-[^\\/]+)[\\/]/,
              priority: 90,
              includeDependenciesRecursively: false,
            },
            {
              name: 'pdf',
              test: /node_modules[\\/](?:jspdf|jspdf-autotable|html2canvas|pdfjs-dist)[\\/]/,
              priority: 90,
              includeDependenciesRecursively: false,
            },
            {
              name: 'xlsx',
              test: /node_modules[\\/]xlsx[\\/]/,
              priority: 90,
              includeDependenciesRecursively: false,
            },
            {
              name: 'tanstack',
              test: /node_modules[\\/]@tanstack[\\/](?:react-table|table-core)[\\/]/,
              priority: 80,
            },
            {
              name: 'date-fns',
              test: /node_modules[\\/]date-fns[\\/]/,
              priority: 80,
            },
          // Lucide ships each icon as its own ESM module.  Vite's default
          // chunker makes ONE chunk PER icon — 45+ tiny HTTP requests on
          // every page load.  Merge them all into a single `icons` chunk.
            {
              name: 'icons',
              test: /node_modules[\\/]lucide-react[\\/]/,
              priority: 80,
            },
          ],
        },
      },
    },
  },
  server: {
    port: 3000,
    // Bind to 0.0.0.0 so other devices on the same Wi-Fi (phones,
    // tablets) can reach the dev server at http://<PC-IP>:3000 —
    // needed for the /worker shop-floor portal on personal phones.
    host: true,
    proxy: {
      '/api': 'http://localhost:3001', // Hono API server
    },
  },
})
