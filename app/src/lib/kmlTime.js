// KML accepts the XSD 1.0 dateTime, date, gYearMonth and gYear forms:
// https://developers.google.com/kml/documentation/kmlreference#timestamp
// https://www.w3.org/TR/xmlschema-2/#dateTime (calendar rules also in Appendix E).
// Appendix D permits second 60; its real-world occurrence is not checked here.
// This is bounded Places validation, not a general XML Schema implementation.
const KML_TIME_VALUE = /^(-?(?:[0-9]{4}|[1-9][0-9]{4,}))(?:-([0-9]{2})(?:-([0-9]{2})(?:T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]+))?)?)?)?(Z|[+-][0-9]{2}:[0-9]{2})?$/;
const DAY_SECONDS = 86_400n;
const UNKNOWN_ZONE_SECONDS = 14n * 3_600n;

export function isValidKmlTimeValue(text) {
  return parseTimeValue(text) !== null;
}

export function isKmlTimeSpanReversed(begin, end) {
  const first = parseTimeValue(begin);
  const last = parseTimeValue(end);
  if (!first || !last) return false;
  // Two unzoned values share the local calendar ordering. If only one zone is
  // missing, retain the full XSD uncertainty of -14:00 through +14:00.
  const mixedZones = (first.zoneMinutes === null) !== (last.zoneMinutes === null);
  const beginRange = timeRange(first, mixedZones);
  const endRange = timeRange(last, mixedZones);
  if (!mixedZones && first.second === 60 && last.second === 60
    && beginRange.upper.seconds === endRange.upper.seconds) {
    // Fractions within the same leap second have an exact relative order.
    return compareInstants(beginRange.upper, endRange.upper) > 0;
  }
  const order = compareInstants(beginRange.lower, endRange.upper);
  return order > 0 || (order === 0 && endRange.upperExclusive);
}

function parseTimeValue(text) {
  if (typeof text !== "string") return null;
  const match = KML_TIME_VALUE.exec(text);
  if (!match) return null;
  const year = BigInt(match[1]);
  if (year === 0n) return null; // XSD 1.0 has no year zero.
  const month = match[2] === undefined ? null : Number(match[2]);
  const day = match[3] === undefined ? null : Number(match[3]);
  const hour = match[4] === undefined ? null : Number(match[4]);
  const minute = Number(match[5] ?? 0);
  const second = Number(match[6] ?? 0);
  const fraction = (match[7] ?? "").replace(/0+$/, "");
  if (month !== null && (month < 1 || month > 12)) return null;
  if (day !== null && (day < 1 || day > daysInMonth(year, month))) return null;
  if (hour !== null && (hour > 24 || minute > 59 || second > 60)) return null;
  if (hour === 24 && (minute !== 0 || second !== 0 || fraction !== "")) return null;
  let zoneMinutes = null;
  if (match[8] === "Z") zoneMinutes = 0;
  else if (match[8]) {
    const hours = Number(match[8].slice(1, 3));
    const minutes = Number(match[8].slice(4, 6));
    if (hours > 14 || minutes > 59 || (hours === 14 && minutes !== 0)) return null;
    zoneMinutes = (match[8][0] === "-" ? -1 : 1) * (hours * 60 + minutes);
  }
  return {year, month, day, hour, minute, second, fraction, zoneMinutes};
}

function daysInMonth(year, month) {
  if (month === 2) return year % 400n === 0n || (year % 4n === 0n && year % 100n !== 0n) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function nextYear(year) {
  return year === -1n ? 1n : year + 1n;
}

function calendarDay(year, month, day) {
  // Ordinal zero is 0001-01-01. Count BCE leap years using their signed XSD
  // year field, skipping the nonexistent year zero without host Date limits.
  const years = year > 0n ? year - 1n : -year;
  let days = 365n * years + years / 4n - years / 100n + years / 400n;
  if (year < 0n) days = -days;
  for (let preceding = 1; preceding < month; preceding += 1) days += BigInt(daysInMonth(year, preceding));
  return days + BigInt(day - 1);
}

function timeRange(value, mixedZones) {
  const {year, month, day, hour, minute, second, fraction, zoneMinutes} = value;
  const zoneSeconds = BigInt(zoneMinutes ?? 0) * 60n;
  let lowerSeconds = calendarDay(year, month ?? 1, day ?? 1) * DAY_SECONDS - zoneSeconds;
  let upperSeconds;
  if (hour !== null) {
    lowerSeconds += BigInt(hour * 3_600 + minute * 60 + second);
    upperSeconds = lowerSeconds;
    // XSD Appendix E treats second 60 as arithmetic overflow. Preserve a
    // one-second comparison interval instead of falsely reversing a valid
    // leap-second fraction followed by the next minute. No leap table lookup
    // or full leap-second normalization/conformance is claimed.
    if (second === 60) lowerSeconds -= 1n;
  } else if (day !== null) upperSeconds = lowerSeconds + DAY_SECONDS;
  else if (month !== null) {
    upperSeconds = calendarDay(month === 12 ? nextYear(year) : year, month === 12 ? 1 : month + 1, 1) * DAY_SECONDS - zoneSeconds;
  } else upperSeconds = calendarDay(nextYear(year), 1, 1) * DAY_SECONDS - zoneSeconds;
  if (mixedZones && zoneMinutes === null) {
    lowerSeconds -= UNKNOWN_ZONE_SECONDS;
    upperSeconds += UNKNOWN_ZONE_SECONDS;
  }
  return {
    lower: {seconds: lowerSeconds, fraction},
    upper: {seconds: upperSeconds, fraction},
    upperExclusive: hour === null
  };
}

function compareInstants(left, right) {
  if (left.seconds !== right.seconds) return left.seconds < right.seconds ? -1 : 1;
  // Pad only comparison copies: arbitrary fractional precision stays exact and
  // original strings are retained by the Places model and KML exporter.
  const length = Math.max(left.fraction.length, right.fraction.length);
  const first = left.fraction.padEnd(length, "0");
  const last = right.fraction.padEnd(length, "0");
  return first === last ? 0 : first < last ? -1 : 1;
}
