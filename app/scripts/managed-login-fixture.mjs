import {readFile} from "node:fs/promises";
import {resolve} from "node:path";
import {fileURLToPath} from "node:url";

export const MANAGED_LOGIN_FIXTURE_SCHEMA =
  "opengeo.managed-login-fixture.1.0.0";

const HEX_COLOR = /^#[0-9a-f]{6}$/;
const PROJECT_CODE = /^[A-Z0-9]+(?:-[A-Z0-9]+)*$/;
const FIELD_TYPES = new Set(["string", "integer"]);
const here = fileURLToPath(new URL(".", import.meta.url));
export const DEFAULT_MANAGED_LOGIN_FIXTURE_PATH = resolve(
  here,
  "../../database/fixtures/auth-browser-dev.json"
);

export async function loadManagedLoginFixture(
  path = DEFAULT_MANAGED_LOGIN_FIXTURE_PATH
) {
  return validateManagedLoginFixture(JSON.parse(await readFile(path, "utf8")));
}

export function validateManagedLoginFixture(value) {
  exactKeys(
    value,
    ["schemaVersion", "environment", "projects", "dataset", "acceptance"],
    "Managed-login fixture"
  );
  if (value.schemaVersion !== MANAGED_LOGIN_FIXTURE_SCHEMA) {
    throw new Error("Managed-login fixture schema is invalid");
  }
  if (value.environment !== "development") {
    throw new Error("Managed-login fixture is outside the development environment");
  }
  if (!Array.isArray(value.projects) || value.projects.length !== 2) {
    throw new Error("Managed-login fixture requires exactly two projects");
  }
  const projects = value.projects.map((project, index) => {
    exactKeys(project, ["name", "code", "mapName", "strokes"], `Project ${index + 1}`);
    const name = boundedText(project.name, `Project ${index + 1} name`, 120);
    const mapName = boundedText(project.mapName, `Project ${index + 1} map name`, 120);
    if (typeof project.code !== "string" || !PROJECT_CODE.test(project.code)) {
      throw new Error(`Project ${index + 1} code is invalid`);
    }
    if (!Array.isArray(project.strokes)
      || project.strokes.length !== 2
      || project.strokes.some((stroke) => !HEX_COLOR.test(stroke))) {
      throw new Error(`Project ${index + 1} strokes are invalid`);
    }
    if (project.strokes[0] === project.strokes[1]) {
      throw new Error(`Project ${index + 1} strokes must be distinct`);
    }
    return Object.freeze({name, mapName, code: project.code, strokes: [...project.strokes]});
  });
  if (new Set(projects.flatMap(({name, mapName, code}) => [name, mapName, code])).size !== 6) {
    throw new Error("Managed-login project identities must be distinct");
  }
  const dataset = validatedDataset(value.dataset);
  const acceptance = validatedAcceptance(value.acceptance, dataset.features.length);
  if (projects[0].strokes.some((stroke) => projects[1].strokes.includes(stroke))) {
    throw new Error("Managed-login project stroke palettes must be independent");
  }
  rejectCredentialMaterial(value);
  return Object.freeze({
    schemaVersion: value.schemaVersion,
    environment: value.environment,
    projects: Object.freeze(projects),
    dataset,
    acceptance
  });
}

function validatedDataset(value) {
  exactKeys(
    value,
    ["name", "description", "geometryType", "fields", "features"],
    "Managed-login dataset"
  );
  const name = boundedText(value.name, "Managed-login dataset name", 120);
  const description = boundedText(
    value.description,
    "Managed-login dataset description",
    500
  );
  if (value.geometryType !== "LineString") {
    throw new Error("Managed-login fixture geometry must be LineString");
  }
  if (!Array.isArray(value.fields) || value.fields.length < 1 || value.fields.length > 16) {
    throw new Error("Managed-login fixture fields are invalid");
  }
  const fields = value.fields.map((field, index) => {
    exactKeys(field, ["name", "type", "required"], `Dataset field ${index + 1}`);
    const fieldName = boundedText(field.name, `Dataset field ${index + 1} name`, 64);
    if (!/^[a-z][a-z0-9_]*$/.test(fieldName)
      || !FIELD_TYPES.has(field.type)
      || field.required !== true) {
      throw new Error(`Dataset field ${index + 1} is invalid`);
    }
    return Object.freeze({name: fieldName, type: field.type, required: true});
  });
  if (new Set(fields.map(({name: fieldName}) => fieldName)).size !== fields.length) {
    throw new Error("Managed-login dataset field names must be distinct");
  }
  if (!Array.isArray(value.features) || value.features.length < 2 || value.features.length > 100) {
    throw new Error("Managed-login fixture features are invalid");
  }
  const features = value.features.map((feature, index) => {
    exactKeys(feature, ["name", "segment", "coordinates"], `Feature ${index + 1}`);
    const featureName = boundedText(feature.name, `Feature ${index + 1} name`, 120);
    if (!Number.isSafeInteger(feature.segment) || feature.segment !== index + 1) {
      throw new Error(`Feature ${index + 1} segment is invalid`);
    }
    if (!Array.isArray(feature.coordinates)
      || feature.coordinates.length < 2
      || feature.coordinates.length > 100) {
      throw new Error(`Feature ${index + 1} coordinates are invalid`);
    }
    const coordinates = feature.coordinates.map((coordinate) => {
      if (!Array.isArray(coordinate)
        || coordinate.length !== 2
        || !Number.isFinite(coordinate[0])
        || !Number.isFinite(coordinate[1])
        || coordinate[0] < -180
        || coordinate[0] > 180
        || coordinate[1] < -90
        || coordinate[1] > 90) {
        throw new Error(`Feature ${index + 1} coordinate is invalid`);
      }
      return Object.freeze([...coordinate]);
    });
    return Object.freeze({name: featureName, segment: feature.segment, coordinates});
  });
  return Object.freeze({
    name,
    description,
    geometryType: value.geometryType,
    fields: Object.freeze(fields),
    features: Object.freeze(features)
  });
}

function validatedAcceptance(value, featureCount) {
  exactKeys(
    value,
    [
      "sharedDatasetProjectCount",
      "governedFeatureCount",
      "narrowViewportWidth",
      "narrowViewportHeight",
      "minimumStatusContrastRatio"
    ],
    "Managed-login fixture acceptance"
  );
  const expected = {
    sharedDatasetProjectCount: 2,
    governedFeatureCount: featureCount,
    narrowViewportWidth: 390,
    narrowViewportHeight: 844,
    minimumStatusContrastRatio: 7
  };
  if (JSON.stringify(value) !== JSON.stringify(expected)) {
    throw new Error("Managed-login fixture acceptance limits are invalid");
  }
  return Object.freeze({...expected});
}

function boundedText(value, label, maximum) {
  if (typeof value !== "string"
    || !value.trim()
    || value !== value.trim()
    || value.length > maximum
    || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
    throw new Error(`${label} contains unexpected or missing fields`);
  }
}

function rejectCredentialMaterial(value) {
  const serialized = JSON.stringify(value);
  if (/(?:access.?key|authorization|credential|password|secret|session.?token)/i.test(serialized)) {
    throw new Error("Managed-login fixture contains credential-oriented material");
  }
}
