import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Vite config for EDGAR Terminal.
 *
 * All personal identifiers are loaded from environment variables so they
 * stay out of version control. If no env vars are set (e.g. fresh clone),
 * a generic public identifier is used as fallback so the app still runs.
 */
export default defineConfig(({ mode }) => {
  // Load env vars from .env files (.env, .env.local, etc.)
  const env = loadEnv(mode, process.cwd(), '');

  // SEC requires SOME User-Agent with a contact method. If you set SEC_USER_AGENT
  // in .env.local, that wins. Otherwise we fall back to a generic identifier
  // that points to the public GitHub repo as the contact channel.
  const secUserAgent =
    env.SEC_USER_AGENT ||
    'EDGAR Terminal Research Tool (github.com/EconometricsEdward/sec-edgar-terminal)';

  return {
    plugins: [react()],
    server: {
      proxy: {
        // SEC Files API (company_tickers.json etc)
        '/sec-files': {
          target: 'https://www.sec.gov',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/sec-files/, '/files'),
          headers: {
            'User-Agent': secUserAgent,
          },
        },
        // SEC Data API (submissions, XBRL)
        '/sec-data': {
          target: 'https://data.sec.gov',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/sec-data/, ''),
          headers: {
            'User-Agent': secUserAgent,
          },
        },
        // Route /api/* to the deployed Vercel serverless functions.
        // This lets local dev use the production /api/prices (stock price waterfall)
        // without needing to run `vercel dev` locally.
        '/api': {
          target: 'https://secedgarterminal.com',
          changeOrigin: true,
          secure: true,
        },
      },
    },
  };
});
