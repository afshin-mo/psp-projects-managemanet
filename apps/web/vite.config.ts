import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// در توسعه، درخواست‌های /api به API محلی (پورت ۳۰۰۰) می‌رود؛ در تولید Nginx همین کار را می‌کند.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': { target: process.env.API_URL ?? 'http://localhost:3000', changeOrigin: true } } },
  build: { chunkSizeWarningLimit: 1500 },
});
