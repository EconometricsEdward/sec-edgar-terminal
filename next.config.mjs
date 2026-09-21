/** @type {import('next').NextConfig} */
const securityHeaders = [
  {
    key: 'X-Content-Type-Options',
    value: 'nosniff',
  },
  {
    key: 'Referrer-Policy',
    value: 'strict-origin-when-cross-origin',
  },
  {
    key: 'X-Frame-Options',
    value: 'DENY',
  },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  },
];

const nextConfig = {
  reactStrictMode: true,
  serverExternalPackages: ['pdfjs-dist', '@napi-rs/canvas', 'tesseract.js', 'tesseract.js-core', '@tesseract.js-data/eng'],
  outputFileTracingIncludes: Object.fromEntries(['/api/filings-reader', '/analysis/*', '/api/v1/analysis/*', '/api/reports/*'].map(route => [route, [
    './node_modules/pdfjs-dist/legacy/build/**', './node_modules/pdfjs-dist/standard_fonts/**', './node_modules/pdfjs-dist/cmaps/**', './node_modules/pdfjs-dist/wasm/**',
    './node_modules/tesseract.js/src/**', './node_modules/tesseract.js/package.json', './node_modules/tesseract.js-core/**', './node_modules/@tesseract.js-data/eng/**', './node_modules/@napi-rs/canvas*/**',
    // Node workers load these outside the server module graph. Include their
    // runtime dependency trees explicitly so deployment matches local OCR.
    ...['bmp-js', 'is-url', 'regenerator-runtime', 'wasm-feature-detect', 'node-fetch', 'whatwg-url', 'tr46', 'webidl-conversions']
      .map(name => `./node_modules/${name}/**`),
  ]])),
  trailingSlash: false,
  // Preserve Next 16's default HTML-limited agents and include research agents
  // that fetch HTML without running the streamed React completion scripts.
  htmlLimitedBots: /[\w-]+-Google|Google-[\w-]+|Chrome-Lighthouse|Slurp|DuckDuckBot|baiduspider|yandex|sogou|bitlybot|tumblr|vkShare|quora link preview|redditbot|ia_archiver|Bingbot|BingPreview|applebot|facebookexternalhit|facebookcatalog|Twitterbot|LinkedInBot|Slackbot|Discordbot|WhatsApp|SkypeUriPreview|Yeti|googleweblight|GPTBot|OAI-SearchBot|ChatGPT-User|ClaudeBot|Claude-SearchBot|Claude-User|anthropic-ai/i,
  async headers() {
    return [
      {
        source: '/:path*',
        headers: securityHeaders,
      },
    ];
  },
  async redirects() {
    return [
      {
        source: '/help',
        destination: '/about',
        permanent: true,
      },
      {
        source: '/crypto',
        destination: 'https://secedgarterminal.com/disclosures',
        permanent: true,
      },
      {
        source: '/:path*',
        has: [{ type: 'host', value: 'www.secedgarterminal.com' }],
        destination: 'https://secedgarterminal.com/:path*',
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
