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
  trailingSlash: false,
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
