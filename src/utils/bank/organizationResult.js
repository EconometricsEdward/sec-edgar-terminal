import { ORGANIZATION_VERSION } from './organizationModel.js';

const identity = (value, rssd) => String(value) === String(rssd);
const positiveId = value => Number.isSafeInteger(value) && value > 0;
const source = value => value && typeof value.url === 'string'
  && typeof value.index === 'string' && Number.isFinite(Date.parse(value.retrievedAt))
  && /^[a-f0-9]{64}$/.test(value.sha256 || '');

/** Check the selected public envelope before retaining an organization view. */
export function isOrganizationResult(body, rssd, part) {
  if (!body || body.error || !identity(body.rssd, rssd) || body.version !== ORGANIZATION_VERSION || !source(body.source)) return false;
  if (body.unavailable) return body.unavailable === 'institution_not_found';
  if (part === 'profile') return !!body.bank && identity(body.bank.rssd, rssd) && positiveId(body.bank.cert)
    && typeof body.bank.name === 'string' && (body.bank.parent === null || positiveId(body.bank.parent?.rssd));
  if (body.parentRssd !== null && !positiveId(body.parentRssd)) return false;
  if (part === 'sec') return ['ready', 'no_parent', 'stale', 'unavailable'].includes(body.sec?.status)
    && Array.isArray(body.sec.candidates) && body.sec.candidates.length <= 5;
  if (part !== 'network' || !Array.isArray(body.missing) || body.missing.some(value => !['offices', 'peers'].includes(value))) return false;
  return (body.offices === null || source(body.offices?.source) && Number.isSafeInteger(body.offices.total)
    && body.offices.total >= 0 && Array.isArray(body.offices.regions))
    && (body.peers === null || source(body.peers?.source) && Array.isArray(body.peers.banks) && body.peers.banks.length <= 1000
      && body.peers.banks.every(bank => positiveId(bank.rssd)));
}

export function reusableOrganizationResult(body, rssd, part) {
  return isOrganizationResult(body, rssd, part) && !body.unavailable && !body.missing?.length
    && !['unavailable', 'stale'].includes(body.sec?.status);
}
