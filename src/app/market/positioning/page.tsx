import { redirect } from 'next/navigation';
import { isCftcEnabled } from '../../../utils/cftcFeature.js';

// Keep the convenience URL as a real HTTP redirect instead of a prerendered
// client-side redirect document. The query-string view remains canonical.
export const dynamic = 'force-dynamic';

export default function CftcPositioningShortcut() {
  redirect(isCftcEnabled() ? '/market?tab=positioning' : '/market');
}
