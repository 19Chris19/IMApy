import core from '../../ima-core/index.js';

// Shared by host task uncertainty and account-health projection. Message text
// is never proof; contradictory status/business evidence is not accepted.
export function getProtocolAuthRejectionEvidence(error) {
  if (!(error instanceof core.IMAWebContractError) || error.code !== 'ima_web_auth_denied') return null;
  if ([401, 403].includes(error.httpStatus) && error.upstreamCode === undefined) return Object.freeze({ httpStatus: error.httpStatus });
  if (error.upstreamCode === 600001 && [undefined, 200].includes(error.httpStatus)) return Object.freeze({ upstreamCode: 600001 });
  return null;
}
