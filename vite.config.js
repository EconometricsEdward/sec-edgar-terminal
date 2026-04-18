import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Two-environment config:
 *
 * LOCAL DEV: Vite proxies /sec-files and /sec-data straight to SEC.gov with our User-Agent.
 *   Fast, no serverless function needed during development.
 *
 * PRODUCTION: The code uses the unified /api/sec endpoint instead, served by Vercel's
 *   serverless function at api/sec.js. The client code chooses between these at runtime
 *   based on import.meta.env.PROD.
 *
 * The User-Agent is loaded from .env.local (git-ignored) in dev and from Vercel
 * environment variables in production.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const userAgent = env.SEC_USER_AGENT || 'Local Dev Placeholder dev@example.com';

  return {
    plugins: [react()],
    server: {
      proxy: {
        '/sec-files': {
          target: 'https://www.sec.gov',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/sec-files/, '/files'),
          headers: { 'User-Agent': userAgent },
        },
        '/sec-data': {
          target: 'https://data.sec.gov',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/sec-data/, ''),
          headers: { 'User-Agent': userAgent },
        },
      },
    },
  };
});
