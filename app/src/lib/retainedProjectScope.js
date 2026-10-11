// Compare the authority and records used by a retained editor. No credentials,
// completed session cache, or writes: a mismatch requires a deliberate reload.
export function retainedProjectScope(state) {
  if (state?.status !== "ready" || !state.selectedMap || state.projectWarnings?.length) return null;
  return JSON.stringify([
    state.session.userId, state.organization, state.project, state.selectedMap,
    state.datasets, state.sources, state.datasetConnectionBindings,
    state.basemapConnectionBindings
  ]);
}

export function retainedPublicationScope(state) {
  if (state?.status !== 'ready' || !state.publication || state.projectWarnings?.length) return null;
  return JSON.stringify([state.session.userId, state.organization, state.project, state.publication]);
}

// This identity stays inside the mounted editor. Fresh resource reads below
// still establish authority; the identity only prevents revealing another login's draft.
export async function retainedPublicationIdentity(adapter) {
  if (typeof adapter.tokenProvider !== 'function' || typeof adapter.organizationProvider !== 'function') return null;
  return {adapter, baseUrl: adapter.baseUrl, tokenProvider: adapter.tokenProvider,
    organizationProvider: adapter.organizationProvider, token: await adapter.tokenProvider(),
    organization: await adapter.organizationProvider()};
}

export async function retainedEditorIdentityStatus(adapter, identity) {
  if (!identity || identity.adapter !== adapter || identity.baseUrl !== adapter.baseUrl
    || identity.tokenProvider !== adapter.tokenProvider || identity.organizationProvider !== adapter.organizationProvider) return 'forbidden';
  const token = await adapter.tokenProvider(), organization = await adapter.organizationProvider();
  return !token ? 'unauthenticated' : token === identity.token && organization === identity.organization ? null : 'forbidden';
}

export async function revalidateRetainedPublication(adapter, expected, identity, {signal} = {}) {
  try {
    signal?.throwIfAborted();
    const current = () => retainedEditorIdentityStatus(adapter, identity);
    const initialMismatch = await current();
    if (initialMismatch) return {status: initialMismatch};
    const [organization, publication, project] = await Promise.all([
      adapter.getCurrentOrganization({signal}), adapter.getPublication(expected.publication.id, {signal}),
      adapter.getProject(expected.project.id, {signal})
    ]);
    signal?.throwIfAborted();
    const finalMismatch = await current();
    if (finalMismatch) return {status: finalMismatch};
    if (publication.id !== expected.publication.id
      || publication.resourceType !== 'publication' || publication.accessContainerId !== expected.project.id
      || organization.id !== expected.organization.id || project.id !== expected.project.id) return {status: 'forbidden'};
    return {...expected, organization, publication, project};
  } catch (error) {
    if (error?.status === 401) adapter.clearSession?.();
    return {status: error?.status === 401 ? 'unauthenticated' : error?.status === 403 ? 'forbidden' : 'error'};
  }
}
