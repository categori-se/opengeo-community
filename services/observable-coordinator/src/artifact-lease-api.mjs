import {CoordinatorContractError} from './contracts.mjs';
import {boundedResponseBytes} from './aws-sigv4.mjs';

// Operator-configured trusted API origin. No destination comes from a claim or pin.
export function artifactLeaseResolver(origin, {fetchImpl = globalThis.fetch} = {}) {
  if (!origin) return null;
  let url;
  try {url = new URL(origin);} catch {throw new CoordinatorContractError('artifact_api_origin_invalid');}
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
      || url.pathname !== '/' || url.port) throw new CoordinatorContractError('artifact_api_origin_invalid');
  return async ({buildJobId, coordinatorToken, authority}) => {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    if (![buildJobId,coordinatorToken,authority?.organizationId,authority?.userId].every(value=>uuid.test(value ?? ''))) {
      throw new CoordinatorContractError('artifact_lease_invalid');
    }
    let response;
    try {
      response = await fetchImpl(`${url.origin}/observable-build-leases/${buildJobId}/artifact-inputs`, {
        method:'POST',credentials:'omit',redirect:'error',signal:AbortSignal.timeout(15000),
        headers:{'content-type':'application/json','accept':'application/json'},
        body:JSON.stringify({organization_id:authority.organizationId,user_id:authority.userId,
          coordinator_token:coordinatorToken})
      });
    } catch {throw new CoordinatorContractError('artifact_api_unavailable',{retryable:true});}
    if (!response.ok) {
      await response.body?.cancel();
      throw new CoordinatorContractError('artifact_resolution_unavailable',
        {retryable:response.status===429 || response.status>=500});
    }
    try {return JSON.parse(await boundedResponseBytes(response,65536));}
    catch {throw new CoordinatorContractError('artifact_resolution_invalid');}
  };
}
