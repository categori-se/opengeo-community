export const contextProviders = Object.freeze({
  kartaview: {name: "KartaView", home: "https://kartaview.org/", terms: "https://kartaview.org/terms", referenceLabel: "Observation metadata"},
  mapillary: {name: "Mapillary", home: "https://www.mapillary.com/app/", terms: "https://help.mapillary.com/hc/en-us/articles/115001770409-CC-BY-SA-license-for-open-data", referenceLabel: "Observation viewer"}
});
export function providerObservation(provider, identifier) {
  if (!Object.hasOwn(contextProviders, provider) || !/^[1-9][0-9]{0,29}$/.test(identifier)) throw new TypeError("Enter a numeric provider observation identifier.");
  return provider === "kartaview" ? `https://api.openstreetcam.org/2.0/photo/${identifier}` : `https://www.mapillary.com/app/?pKey=${identifier}`;
}
export function providerExplore(provider, geometry) {
  if (!Object.hasOwn(contextProviders, provider)) throw new TypeError("Unknown provider");
  if (provider === "kartaview" && geometry?.type === "Point") {
    const [longitude, latitude] = geometry.coordinates ?? [];
    if (Number.isFinite(longitude) && Number.isFinite(latitude) && Math.abs(longitude)<=180 && Math.abs(latitude)<=90)
      return `https://kartaview.org/map/@${latitude},${longitude},15z`;
  }
  return contextProviders[provider].home;
}
export function appendProviderContext(knowledge, {provider, identifier, attribution = "", confidence = null}, now = new Date().toISOString()) {
  const resourceId = providerObservation(provider, identifier), source = contextProviders[provider];
  if (confidence !== null && (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)) throw new TypeError("Confidence must be between zero and one.");
  if (typeof attribution !== "string" || attribution.length > 2000) throw new TypeError("Attribution is too long.");
  const next = structuredClone(knowledge);
  if (!Array.isArray(next.context) || !Array.isArray(next.metadata?.curated)) throw new TypeError("Load valid recorded knowledge first.");
  if (next.context.some(item => item.resourceId === resourceId)) throw new TypeError("This observation is already recorded.");
  if (next.context.length >= 64 || next.metadata.curated.length >= 64) throw new TypeError("The metadata record has reached its entry limit.");
  const evidence = [resourceId, source.terms];
  next.context.push({resourceId, relationship: "http://purl.org/dc/terms/relation", evidence, ...(confidence === null ? {} : {confidence})});
  next.metadata.curated.push({subject: "resource", property: "http://purl.org/dc/terms/relation",
    value: {provider: source.name, reference: resourceId, observationIdentifier: identifier,
      attribution: attribution.trim() || null, license: null, accessRights: null, rights: null, policy: null,
      verification: "user_supplied_unverified"}, provenance: "curator_asserted", evidence,
    method: "Manual provider reference; no provider retrieval or rights verification", timestamp: now,
    agent: "OpenGeo.Tools Studio", ...(confidence === null ? {} : {confidence})});
  return next;
}

// Resolve only supported provider references; never turn arbitrary metadata into links.
export function recordedProviderContexts(knowledge) {
  return (knowledge?.context ?? []).flatMap(context => {
    for (const [provider, source] of Object.entries(contextProviders)) {
      const pattern = provider === "kartaview"
        ? /^https:\/\/api\.openstreetcam\.org\/2\.0\/photo\/([1-9][0-9]{0,29})$/
        : /^https:\/\/www\.mapillary\.com\/app\/\?pKey=([1-9][0-9]{0,29})$/;
      const match = pattern.exec(context.resourceId);
      if (!match) continue;
      const assertion = [...(knowledge.metadata?.curated ?? [])].reverse().find(item =>
        item.property === "http://purl.org/dc/terms/relation" && item.value?.reference === context.resourceId);
      return [{provider, name: source.name, identifier: match[1], href: context.resourceId,
        attribution: typeof assertion?.value?.attribution === "string" ? assertion.value.attribution : null,
        confidence: context.confidence ?? null}];
    }
    return [];
  });
}
