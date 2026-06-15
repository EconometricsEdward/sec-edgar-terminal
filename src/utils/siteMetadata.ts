import type { Metadata } from 'next';

export const SITE_URL = 'https://secedgarterminal.com';
export const SITE_NAME = 'EDGAR Terminal';
export const OG_IMAGE_URL = `${SITE_URL}/og-image.png`;

const OG_IMAGE = {
  url: OG_IMAGE_URL,
  width: 1200,
  height: 630,
  alt: 'EDGAR Terminal interface for source-linked SEC filings and financial analysis',
};

interface PageMetadataInput {
  title: string;
  description: string;
  path: `/${string}`;
}

export function canonicalUrl(path: `/${string}`) {
  return `${SITE_URL}${path}`;
}

export function buildPageMetadata({
  title,
  description,
  path,
}: PageMetadataInput): Metadata {
  const canonical = canonicalUrl(path);

  return {
    title,
    description,
    alternates: { canonical },
    openGraph: {
      title,
      description,
      url: canonical,
      type: 'website',
      siteName: SITE_NAME,
      locale: 'en_US',
      images: [OG_IMAGE],
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      images: [OG_IMAGE_URL],
    },
  };
}
