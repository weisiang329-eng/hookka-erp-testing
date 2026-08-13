import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

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

// ───────────────────────────────────────────────────────────────────────────
// vendorChunkOf — manual vendor chunk splitting so the main bundle doesn't
// ship heavy libs (recharts, jspdf, xlsx, pdfjs-dist) that are only needed on
// specific pages. Everything else stays in the main chunk.
//
// This is the SAME function that used to sit inline as
// `rollupOptions.output.manualChunks`, moved out verbatim so it can be passed
// as a `codeSplitting` group's `name()`. See the codeSplitting block below for
// why the API had to change.
// ───────────────────────────────────────────────────────────────────────────
function vendorChunkOf(id: string): string | undefined {
  if (!id.includes('node_modules')) return
  // Split react-vendor into 3 parallel chunks (owner 2026-06-29: the
  // single 87 KB react-vendor took 38 s on a flaky factory wifi
  // because all of React had to arrive before paint).
  //   • react-core   = react + scheduler (small, ~10 KB)
  //   • react-dom    = the bulk of the runtime (~75 KB)
  //   • react-router = routing only (~10 KB)
  // On HTTP/2 all 3 stream in parallel; if one stalls the other 2
  // can still finish, and React can boot the moment react-core +
  // react-dom both arrive — router can land slightly after.
  if (
    id.includes('node_modules/react/') ||
    id.includes('node_modules/scheduler/')
  ) {
    return 'react-core'
  }
  if (id.includes('node_modules/react-dom/')) {
    return 'react-dom'
  }
  if (
    id.includes('node_modules/react-router-dom/') ||
    id.includes('node_modules/react-router/')
  ) {
    return 'react-router'
  }
  if (id.includes('node_modules/recharts/') || id.includes('node_modules/d3-')) {
    return 'charts'
  }
  if (
    id.includes('node_modules/jspdf/') ||
    id.includes('node_modules/jspdf-autotable/') ||
    id.includes('node_modules/html2canvas/') ||
    id.includes('node_modules/pdfjs-dist/')
  ) {
    return 'pdf'
  }
  if (id.includes('node_modules/xlsx/')) {
    return 'xlsx'
  }
  if (id.includes('node_modules/@tanstack/react-table/') || id.includes('node_modules/@tanstack/table-core/')) {
    return 'tanstack'
  }
  if (id.includes('node_modules/date-fns/')) {
    return 'date-fns'
  }
  // Lucide ships each icon as its own ESM module.  Vite's default
  // chunker makes ONE chunk PER icon — 45+ tiny HTTP requests on
  // every page load.  Merge them all into a single `icons` chunk.
  if (id.includes('node_modules/lucide-react/')) {
    return 'icons'
  }
}

// Plain HTTP dev server. Live-camera scanning (getUserMedia) is gated by
// the browser to HTTPS or localhost — on LAN phones it fails silently.
// Workers use the Upload photos path instead (multiple select + batch
// queue), which works fine over HTTP.
export default defineConfig({
  // Build-time identifier injected as a global constant. Used by
  // src/lib/cached-fetch.ts to namespace localStorage cache entries —
  // every new build gets a unique namespace so old cached payloads from
  // a previous deploy automatically orphan instead of haunting users
  // through the next deploy. No manual cache-clear ever needed.
  define: {
    __BUILD_ID__: JSON.stringify(Date.now().toString(36)),
  },
  plugins: [react(), tailwindcss(), stripCrossorigin()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    // Pinned, not left to the default: public/_headers hard-codes the
    // `/assets/*` rule (immutable, 1y) and functions/assets/[[path]].ts only
    // intercepts that prefix. If Vite's default ever moved, both would silently
    // stop applying to the real build output — cache policy and the missing-
    // asset 404 would just quietly not happen. Houzs-ERP #1449, same reasoning.
    assetsDir: "assets",
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
    // matching /pdf-|xlsx-/ from the preload list. The chunks still
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
        return deps.filter((d) => !/(^|\/)(pdf|xlsx)-[A-Za-z0-9_-]+\.js$/.test(d));
      },
    },
    rollupOptions: {
      output: {
        // ─────────────────────────────────────────────────────────────
        // Chunk grouping — `codeSplitting.groups`, NOT `manualChunks`.
        //
        // Group 1 gives Vite's dynamic-import helper `__vitePreload` its own
        // ~1 KB chunk. It is a VIRTUAL module (a NUL-prefixed `vite/preload-helper.js`,
        // vite/src/node/plugins/importAnalysisBuild.ts) with no node_modules
        // path, so `vendorChunkOf` never named it and rolldown's automatic
        // chunker decided where it lived. Where it decided: INSIDE the `pdf`
        // chunk. Every chunk containing an `await import(...)` needs the
        // helper, so each one took a HARD STATIC edge on 1,036 KB of jspdf +
        // pdfjs-dist + html2canvas to reach a ~1 KB function:
        //
        //   employees-D5mT946N build:  import{c as r}from"./pdf-D5mT946N.js"
        //
        // Measured on the 2026-08-13 build: 53 chunks carried that edge —
        // employees, accounting, customers, delivery, inventory, products,
        // dashboard-b, react-router, … none of which touch a PDF library.
        // /employees alone pulled a 1,997 KB static graph on mount, more than
        // half of it PDF vendor code it never calls. Afterwards: 18 importers,
        // all of them real PDF consumers.
        //
        // `modulePreload.resolveDependencies` above does NOT fix this. It
        // strips <link rel=modulepreload> HINTS; this is an `import` EDGE, and
        // the browser must still fetch + evaluate the chunk before the page
        // module can run. The edge itself is correct — the helper genuinely is
        // shared code — so the fix is to make it point at 1 KB, not 1 MB.
        //
        // Why the API changed with it: rolldown maps `manualChunks` onto a
        // single `codeSplitting` group whose `name()` is the old callback, and
        // in that shim a name returned for the preload helper is SILENTLY
        // IGNORED — verified on this tree, `return 'vite-preload'` from
        // manualChunks left the helper in the pdf chunk and emitted no
        // vite-preload chunk at all. A group with an explicit `test` captures
        // it. `manualChunks` and `codeSplitting` are mutually exclusive (set
        // both and manualChunks is dropped with a warning), so group 2 carries
        // the previous chunker verbatim as its `name()` — every other chunk
        // stem is unchanged, which `scripts/check-bundle-size.mjs` verifies.
        // ─────────────────────────────────────────────────────────────
        codeSplitting: {
          groups: [
            {
              name: 'vite-preload',
              test: /preload-helper/,
              priority: 100,
              minSize: 0,
            },
            {
              // The former `manualChunks` callback, unchanged. rolldown wants
              // `string | null`; the callback returns `undefined` for "no
              // opinion, use automatic chunking".
              name: (id: string) => vendorChunkOf(id) ?? null,
              priority: 1,
              minSize: 0,
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
