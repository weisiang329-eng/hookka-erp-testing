import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

// Plain HTTP dev server. Live-camera scanning (getUserMedia) is gated by
// the browser to HTTPS or localhost — on LAN phones it fails silently.
// Workers use the Upload photos path instead (multiple select + batch
// queue), which works fine over HTTP.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    rollupOptions: {
      output: {
        // Manual vendor chunk splitting so the main bundle doesn't
        // ship heavy libs (recharts, jspdf, xlsx, pdfjs-dist) that
        // are only needed on specific pages. Everything else stays
        // in the main chunk.
        manualChunks: (id) => {
          if (!id.includes('node_modules')) return
          if (
            id.includes('node_modules/react/') ||
            id.includes('node_modules/react-dom/') ||
            id.includes('node_modules/react-router-dom/') ||
            id.includes('node_modules/react-router/') ||
            id.includes('node_modules/scheduler/')
          ) {
            return 'react-vendor'
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
