// OpenGeo adaptation; upstream attribution and terms: ../assets/licenses/open-location-code.NOTICE.txt
// Open Location Code specification:
// https://github.com/google/open-location-code/blob/83986da0156bbf51fba33d0327d8ca4b7f955c89/Documentation/Specification/specification.md
const ALPHABET = '23456789CFGHJMPQRVWX';
const PAIR_RESOLUTIONS = [160000, 8000, 400, 20, 1];
const UNITS_PER_DEGREE = 8000;
const INVALID_CODE = 'Enter a valid full Plus Code, such as 8FVC9G8F+6W.';

/** Decode a full Plus Code to its WGS84 cell and center, without a network lookup. */
export function decodeFullPlusCode(value) {
  // Bound work before trimming, case conversion or regular expressions.
  if (typeof value !== 'string' || value.length > 256) {
    throw new Error(INVALID_CODE);
  }
  const input = value.trim();
  const code = input.toUpperCase();
  const separator = code.indexOf('+');
  if (separator >= 0 && separator < 8) {
    throw new Error('Short Plus Codes need a reference location. Enter a full Plus Code.');
  }
  if (code.length > 16 || !/^[0-9A-Za-z+]+$/.test(input)
    || !/^[23456789CFGHJMPQRVWX0]{8}\+[23456789CFGHJMPQRVWX]{0,7}$/.test(code)) {
    throw new Error(INVALID_CODE);
  }

  const prefix = code.slice(0, 8);
  const suffix = code.slice(9);
  const padding = prefix.indexOf('0');
  if (suffix.length === 1 || (padding >= 0 && (
    padding < 2 || padding % 2 !== 0 || suffix.length > 0 || !/^0+$/.test(prefix.slice(padding))
  ))) {
    throw new Error(INVALID_CODE);
  }
  if (ALPHABET.indexOf(prefix[0]) >= 9 || ALPHABET.indexOf(prefix[1]) >= 18) {
    throw new Error('This Plus Code is outside the latitude or longitude range of the Earth.');
  }

  const codeLength = padding >= 0 ? padding : 8 + suffix.length;
  const digits = padding >= 0 ? prefix.slice(0, padding) : prefix + suffix;
  let latitudeUnits = -90 * UNITS_PER_DEGREE;
  let longitudeUnits = -180 * UNITS_PER_DEGREE;
  let resolutionUnits;
  for (let position = 0; position < Math.min(codeLength, 10); position += 2) {
    resolutionUnits = PAIR_RESOLUTIONS[position / 2];
    latitudeUnits += ALPHABET.indexOf(digits[position]) * resolutionUnits;
    longitudeUnits += ALPHABET.indexOf(digits[position + 1]) * resolutionUnits;
  }

  // Grid digits divide latitude into five rows and longitude into four columns.
  // Retain integer numerators until the final conversion to degrees.
  let latitudeGrid = 0;
  let longitudeGrid = 0;
  let latitudeScale = 1;
  let longitudeScale = 1;
  for (let position = 10; position < codeLength; position += 1) {
    const digit = ALPHABET.indexOf(digits[position]);
    latitudeGrid = latitudeGrid * 5 + Math.floor(digit / 4);
    longitudeGrid = longitudeGrid * 4 + digit % 4;
    latitudeScale *= 5;
    longitudeScale *= 4;
  }

  const latitudeNumerator = latitudeUnits * latitudeScale + latitudeGrid;
  const longitudeNumerator = longitudeUnits * longitudeScale + longitudeGrid;
  const latitudeDenominator = UNITS_PER_DEGREE * latitudeScale;
  const longitudeDenominator = UNITS_PER_DEGREE * longitudeScale;
  return {
    code,
    codeLength,
    latitude: (latitudeNumerator + resolutionUnits / 2) / latitudeDenominator,
    longitude: (longitudeNumerator + resolutionUnits / 2) / longitudeDenominator,
    bounds: {
      south: latitudeNumerator / latitudeDenominator,
      west: longitudeNumerator / longitudeDenominator,
      north: (latitudeNumerator + resolutionUnits) / latitudeDenominator,
      east: (longitudeNumerator + resolutionUnits) / longitudeDenominator
    },
    latitudeResolution: resolutionUnits / latitudeDenominator,
    longitudeResolution: resolutionUnits / longitudeDenominator
  };
}

// Encode only the unpadded lengths used by recovery. Integer scales cover the
// finest supported grid; latitude +90 uses the last cell and longitude wraps.
function encodeRecoveryPoint(latitude, longitude, codeLength = 10) {
  const latitudePrecision = UNITS_PER_DEGREE * 3125;
  const longitudePrecision = UNITS_PER_DEGREE * 1024;
  const longitudeRange = 360 * longitudePrecision;
  const latitudeInteger = Math.max(0, Math.min(180 * latitudePrecision - 1,
    Math.floor(latitude * latitudePrecision) + 90 * latitudePrecision));
  const longitudeInteger = ((Math.floor(longitude * longitudePrecision)
    + 180 * longitudePrecision) % longitudeRange + longitudeRange) % longitudeRange;
  let latitudePairs = Math.floor(latitudeInteger / 3125);
  let longitudePairs = Math.floor(longitudeInteger / 1024);
  let digits = '';
  for (const resolution of PAIR_RESOLUTIONS) {
    digits += ALPHABET[Math.floor(latitudePairs / resolution)]
      + ALPHABET[Math.floor(longitudePairs / resolution)];
    latitudePairs %= resolution;
    longitudePairs %= resolution;
  }
  let latitudeGrid = latitudeInteger % 3125;
  let longitudeGrid = longitudeInteger % 1024;
  let latitudeResolution = 3125;
  let longitudeResolution = 1024;
  for (let position = 10; position < codeLength; position += 1) {
    latitudeResolution /= 5;
    longitudeResolution /= 4;
    digits += ALPHABET[Math.floor(latitudeGrid / latitudeResolution) * 4
      + Math.floor(longitudeGrid / longitudeResolution)];
    latitudeGrid %= latitudeResolution;
    longitudeGrid %= longitudeResolution;
  }
  return digits.slice(0, 8) + '+' + digits.slice(8, codeLength);
}

/** Resolve a full code, or recover a short code nearest an explicit WGS84 point. */
export function resolvePlusCode(value, reference = null) {
  if (typeof value !== 'string' || value.length > 256) throw new Error(INVALID_CODE);
  const input = value.trim();
  const separator = input.indexOf('+');
  if (separator < 0 || separator >= 8) return decodeFullPlusCode(value);

  const shortCode = input.toUpperCase();
  const missingDigits = 8 - separator;
  const codeLength = missingDigits + shortCode.length - 1;
  if (!/^[0-9A-Za-z+]+$/.test(input) || separator % 2 !== 0 || shortCode === '+'
    || codeLength > 15 || shortCode.length - separator - 1 === 1
    || !/^[23456789CFGHJMPQRVWX]{0,6}\+[23456789CFGHJMPQRVWX]{0,7}$/.test(shortCode)) {
    throw new Error('Enter a valid short Plus Code without locality text or padding.');
  }
  if (reference == null) {
    throw new Error('Short Plus Codes need a reference location. Supply an explicit reference or enter a full Plus Code.');
  }
  const {latitude: referenceLatitude, longitude: suppliedLongitude} = reference;
  if (!Number.isFinite(referenceLatitude) || !Number.isFinite(suppliedLongitude)
    || referenceLatitude < -90 || referenceLatitude > 90
    || suppliedLongitude < -180 || suppliedLongitude > 180) {
    throw new Error('Use a reference with finite WGS84 latitude (-90 to 90) and longitude (-180 to 180).');
  }

  // Follow recoverNearest's strict half-cell comparisons and pole guards:
  // https://github.com/google/open-location-code/blob/83986da0156bbf51fba33d0327d8ca4b7f955c89/js/src/openlocationcode.js
  const referenceLongitude = suppliedLongitude === 180 ? -180 : suppliedLongitude;
  const recoveryResolution = 20 ** (2 - missingDigits / 2);
  const halfResolution = recoveryResolution / 2;
  const prefix = encodeRecoveryPoint(referenceLatitude, referenceLongitude).slice(0, missingDigits);
  const candidate = decodeFullPlusCode(prefix + shortCode);
  let {latitude, longitude} = candidate;
  if (referenceLatitude + halfResolution < latitude && latitude - recoveryResolution >= -90) {
    latitude -= recoveryResolution;
  } else if (referenceLatitude - halfResolution > latitude && latitude + recoveryResolution <= 90) {
    latitude += recoveryResolution;
  }
  if (referenceLongitude + halfResolution < longitude) {
    longitude -= recoveryResolution;
  } else if (referenceLongitude - halfResolution > longitude) {
    longitude += recoveryResolution;
  }
  return {
    ...decodeFullPlusCode(encodeRecoveryPoint(latitude, longitude, candidate.codeLength)),
    shortCode,
    reference: {latitude: referenceLatitude, longitude: suppliedLongitude}
  };
}
