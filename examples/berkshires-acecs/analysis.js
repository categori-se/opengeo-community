/** Summarize the retained municipal ACEC records without summing area fields. */
export function summarizeArchive(archive) {
  if (archive?.type !== "FeatureCollection" || !Array.isArray(archive.features)) {
    throw new TypeError("Expected a GeoJSON FeatureCollection.");
  }

  const byDesignation = new Map();
  const byMunicipality = new Map();
  for (const [index, feature] of archive.features.entries()) {
    const properties = feature?.properties;
    if (feature?.type !== "Feature" || feature.geometry?.type !== "MultiPolygon"
      || !Number.isSafeInteger(properties?.ACECID) || properties.ACECID <= 0
      || ![properties.NAME, properties.DES_DATE, properties.TOWN].every(
        value => typeof value === "string" && value.trim().length > 0)) {
      throw new TypeError(`Invalid ACEC record at index ${index}.`);
    }

    const {ACECID: id, NAME: name, DES_DATE: designationDate, TOWN: town} = properties;
    let designation = byDesignation.get(id);
    if (!designation) {
      designation = {id, name, designationDate, recordCount: 0, towns: new Set()};
      byDesignation.set(id, designation);
    } else if (designation.name !== name || designation.designationDate !== designationDate) {
      throw new TypeError(`Conflicting name or designation date for ACECID ${id}.`);
    }
    designation.recordCount += 1;
    designation.towns.add(town);

    let municipality = byMunicipality.get(town);
    if (!municipality) {
      municipality = {town, recordCount: 0, designationIds: new Set()};
      byMunicipality.set(town, municipality);
    }
    municipality.recordCount += 1;
    municipality.designationIds.add(id);
  }

  const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;
  const designations = [...byDesignation.values()]
    .sort((left, right) => left.id - right.id)
    .map(value => ({...value, towns: [...value.towns].sort(compareText)}));
  const municipalities = [...byMunicipality.values()]
    .sort((left, right) => compareText(left.town, right.town))
    .map(value => ({
      town: value.town,
      recordCount: value.recordCount,
      designationCount: value.designationIds.size,
      designationIds: [...value.designationIds].sort((left, right) => left - right)
    }));

  return {
    recordCount: archive.features.length,
    designationCount: designations.length,
    municipalityCount: municipalities.length,
    designations,
    municipalities
  };
}
