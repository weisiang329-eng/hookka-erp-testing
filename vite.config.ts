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
