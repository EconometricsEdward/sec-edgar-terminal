import React from 'react';
import { Helmet } from 'react-helmet-async';

const SITE_NAME = 'EDGAR Terminal';
const SITE_URL = 'https://secedgarterminal.com';
const DEFAULT_OG_IMAGE = `${SITE_URL}/og-image.png`;

/**
 * Reusable SEO component for per-page meta tags.
 *
 * Usage:
 *   <SEO
 *     title="Apple Inc. (AAPL) — SEC Filings"
 *     description="Complete SEC filing history for Apple Inc..."
 *     path="/filings/AAPL"
 *   />
 *
 * Props:
 *   - title: page-specific title (will be suffixed with " | EDGAR Terminal")
 *   - description: 140-160 char meta description
 *   - path: current route path, e.g. "/filings/AAPL" (used for canonical URL)
 *   - ogImage (optional): override the default Open Graph image
 *   - noindex (optional): set true to exclude from search engines (e.g. for error pages)
 */
export default function SEO({ title, description, path = '', ogImage, noindex = false }) {
  const fullTitle = title
    ? `${title} | ${SITE_NAME}`
    : `${SITE_NAME} — SEC Filings & Financial Data Explorer`;

  const canonicalUrl = `${SITE_URL}${path}`;
  const imageUrl = ogImage || DEFAULT_OG_IMAGE;

  return (
    <Helmet>
      {/* Standard meta */}
      <title>{fullTitle}</title>
      <meta name="description" content={description} />
      <link rel="canonical" href={canonicalUrl} />
      {noindex && <meta name="robots" content="noindex, nofollow" />}

      {/* Open Graph (Facebook, LinkedIn, etc.) */}
      <meta property="og:type" content="website" />
      <meta property="og:site_name" content={SITE_NAME} />
      <meta property="og:title" content={fullTitle} />
      <meta property="og:description" content={description} />
      <meta property="og:url" content={canonicalUrl} />
      <meta property="og:image" content={imageUrl} />

      {/* Twitter / X */}
      <meta name="twitter:card" content="summary_large_image" />
      <meta name="twitter:title" content={fullTitle} />
      <meta name="twitter:description" content={description} />
      <meta name="twitter:image" content={imageUrl} />
    </Helmet>
  );
}
