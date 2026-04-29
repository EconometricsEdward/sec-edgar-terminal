import { redirect } from 'next/navigation';

// ============================================================================
// Custom 404 handler
//
// Next.js's default behavior for unmatched URLs is to render a generic
// not-found page. We preserve the prior behavior — typo'd URLs go home —
// by redirecting to / instead. This matches the React Router <Navigate to="/" />
// fallback that App.jsx used to provide.
//
// Server-side redirect (HTTP 307) — happens before any HTML is sent.
// Bots and CDNs handle this cleanly; users see no flicker.
// ============================================================================
export default function NotFound() {
  redirect('/');
}
