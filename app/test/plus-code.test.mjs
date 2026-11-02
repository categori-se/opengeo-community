import assert from 'node:assert/strict';
import {it} from 'node:test';
import {decodeFullPlusCode, resolvePlusCode} from '../src/lib/plusCode.js';

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);

it('decodes the published Zurich example and normalizes case without changing the input', () => {
  const input = ' \t8fvc9g8f+6w\n';
  const result = decodeFullPlusCode(input);
  assert.equal(input, ' \t8fvc9g8f+6w\n');
  assert.equal(result.code, '8FVC9G8F+6W');
  assert.equal(result.codeLength, 10);
  close(result.latitude, 47.3655625);
  close(result.longitude, 8.5248125);
  close(result.bounds.south, 47.3655);
  close(result.bounds.north, 47.365625);
  close(result.bounds.west, 8.52475);
  close(result.bounds.east, 8.524875);
  close(result.latitudeResolution, 0.000125);
  close(result.longitudeResolution, 0.000125);
});

// Independent expected cells from the official Open Location Code test vectors:
// https://github.com/google/open-location-code/blob/83986da0156bbf51fba33d0327d8ca4b7f955c89/test_data/decoding.csv
const cells = [
  ['84000000+', 2, 30, -140, 50, -120],
  ['7FG40000+', 4, 20, 2, 21, 3],
  ['7FG49Q00+', 6, 20.35, 2.75, 20.4, 2.8],
  ['4VXPHWHV+', 8, -30.4225, 174.9425, -30.42, 174.945],
  ['4VCPPQGP+Q9', 10, -41.273125, 174.785875, -41.273, 174.786],
  ['7FG49QCJ+2VX', 11, 20.3701, 2.78221875, 20.370125, 2.78225],
  ['4J86FVGW+9449', 12, -43.52412, 64.8953359375, -43.524115, 64.89534375],
  ['7FG49QCJ+2VXGJ', 13, 20.370113, 2.782234375, 20.370114, 2.78223632813],
  ['8J7GRCCX+FMJWRQ', 14, 35.8212246, 70.449142089844, 35.8212248, 70.449142578125],
  ['849VGJQF+VX7QR3J', 15, 37.53966912, -122.3750698242, 37.53966916, -122.3750697021],
  ['22222222+22', 10, -90, -180, -89.999875, -179.999875],
  ['6VGX0000+', 4, 0, 179, 1, 180],
  ['CFX3X2X2+X2', 10, 89.999875, 1, 90, 1.000125]
];
for (const [code, length, south, west, north, east] of cells) {
  it(`decodes the independent cell for ${code}`, () => {
    const result = decodeFullPlusCode(code);
    assert.equal(result.codeLength, length);
    close(result.bounds.south, south);
    close(result.bounds.west, west);
    close(result.bounds.north, north);
    close(result.bounds.east, east);
    close(result.latitude, (south + north) / 2);
    close(result.longitude, (west + east) / 2);
    close(result.latitudeResolution, north - south);
    close(result.longitudeResolution, east - west);
  });
}

it('keeps the full WGS84 extent for polar and date-line cells', () => {
  const southwest = decodeFullPlusCode('22000000+');
  assert.deepEqual(southwest.bounds, {south: -90, west: -180, north: -70, east: -160});
  assert.equal(southwest.latitude, -80);
  assert.equal(southwest.longitude, -170);
  const northeast = decodeFullPlusCode('CVXXXXXX+XXXXXXX');
  assert.equal(northeast.bounds.north, 90);
  assert.equal(northeast.bounds.east, 180);
  assert.ok(northeast.latitude < 90 && northeast.longitude < 180);
  close(northeast.latitudeResolution, 0.00000004);
  close(northeast.longitudeResolution, 0.0000001220703125);
});

it('requires an explicit reference for short codes, including codes with a locality', () => {
  for (const code of ['VC9G8F+6W', '9G8F+6W', '8F+6W', '+6W', '9G8F+6W Zurich']) {
    assert.throws(() => decodeFullPlusCode(code), /Short Plus Codes need a reference location/);
  }
});

it('rejects malformed length, separators, alphabet and padding', () => {
  for (const code of [
    '', '8FVC9G8F6W', '8FVC9G8F6+W', '8FVC9G8F++6W', '8FVC9G8F+6', '8FVC9G8F+6W222222',
    '8FVC9G8F+6O', '8FVC9G8F+6I', '8FVC9G8F+6B', '8FVC9G8F+6W Zurich',
    '00000000+', '80000000+', '8FV00000+', '8FVC9000+', '8FVC9G80+',
    '8F0C0000+', '8F00G000+', '8FVC9G00+6W', '8FVC9G8F+00',
    '8FVC9G8F +6W', '8FVC9G8F+６Ｗ', '8ﬀC9G8F+6W', '8FVC9G8F+6W' + ' '.repeat(256),
    null, undefined, 123, {toString: () => '8FVC9G8F+6W'}
  ]) {
    assert.throws(() => decodeFullPlusCode(code), /valid full Plus Code/);
  }
});

it('rejects codes outside the Earth instead of wrapping their coordinates', () => {
  for (const code of ['FFVC9G8F+6W', 'XX000000+', '8WVC9G8F+6W', '8X000000+']) {
    assert.throws(() => decodeFullPlusCode(code), /outside the latitude or longitude range/);
  }
});

// Independent recovery vectors, including neighbouring prefixes and pole guards:
// https://github.com/google/open-location-code/blob/83986da0156bbf51fba33d0327d8ca4b7f955c89/test_data/shortCodeTests.csv
const recoveries = [
  ['9C3W9QCJ+2VX', 51.3701125, -1.217765625, '+2VX'],
  ['9C3W9QCJ+2VX', 51.3708675, -1.217765625, 'CJ+2VX'],
  ['9C3W9QCJ+2VX', 51.3693575, -1.217765625, 'CJ+2VX'],
  ['9C3W9QCJ+2VX', 51.3701125, -1.218520625, 'CJ+2VX'],
  ['9C3W9QCJ+2VX', 51.3701125, -1.217010625, 'CJ+2VX'],
  ['9C3W9QCJ+2VX', 51.3852125, -1.217765625, '9QCJ+2VX'],
  ['9C3W9QCJ+2VX', 51.3550125, -1.217765625, '9QCJ+2VX'],
  ['9C3W9QCJ+2VX', 51.3701125, -1.232865625, '9QCJ+2VX'],
  ['9C3W9QCJ+2VX', 51.3701125, -1.202665625, '9QCJ+2VX'],
  ['8FJFW222+', 42.899, 9.012, '22+'],
  ['796RXG22+', 14.95125, -23.5001, '22+'],
  ['8FVC2GGG+GG', 46.976, 8.526, '2GGG+GG'],
  ['8FRCXGGG+GG', 47.026, 8.526, 'XGGG+GG'],
  ['8FR9GXGG+GG', 46.526, 8.026, 'GXGG+GG'],
  ['8FRCG2GG+GG', 46.526, 7.976, 'G2GG+GG'],
  ['CFX22222+22', 89.6, 0, '2222+22'],
  ['2CXXXXXX+XX', -81, 0, 'XXXXXX+XX']
];
for (const [fullCode, latitude, longitude, shortCode] of recoveries) {
  it(`recovers ${shortCode} nearest the official reference ${latitude}, ${longitude}`, () => {
    const reference = Object.freeze({latitude, longitude});
    const result = resolvePlusCode(shortCode, reference);
    const {shortCode: recoveredShortCode, reference: retainedReference, ...cell} = result;
    assert.deepEqual(cell, decodeFullPlusCode(fullCode));
    assert.equal(recoveredShortCode, shortCode);
    assert.deepEqual(retainedReference, reference);
    assert.notEqual(retainedReference, reference);
  });
}

it('preserves the full-code result and ignores an unused reference', () => {
  for (const code of ['8FRCG2GG+GG', '8frCG2GG+gG', '84000000+', '849VGJQF+VX7QR3J']) {
    assert.deepEqual(resolvePlusCode(code), decodeFullPlusCode(code));
    assert.deepEqual(resolvePlusCode(code, {latitude: NaN}), decodeFullPlusCode(code));
  }
});

it('normalizes short-code case and preserves grid precision and explicit reference values', () => {
  const reference = {latitude: 37.53967, longitude: -122.37507};
  const result = resolvePlusCode(' \tgjqf+vx7qr3j\n', reference);
  assert.equal(result.code, '849VGJQF+VX7QR3J');
  assert.equal(result.shortCode, 'GJQF+VX7QR3J');
  assert.equal(result.codeLength, 15);
  assert.deepEqual(result.reference, reference);
  result.reference.latitude = 0;
  assert.equal(reference.latitude, 37.53967);
});

it('recovers independently known cells across the date line and at both poles', () => {
  for (const longitude of [-180, -179.999, 179.999, 180]) {
    const east = resolvePlusCode('2222+22', {latitude: 0, longitude});
    assert.equal(east.code, '62G22222+22');
    close(east.bounds.west, -180);
    assert.equal(east.reference.longitude, longitude);
    const west = resolvePlusCode('XXXX+XX', {latitude: 0, longitude});
    assert.equal(west.code, '6VFXXXXX+XX');
    close(west.bounds.east, 180);
  }
  assert.equal(resolvePlusCode('XXXX+XX', {latitude: 90, longitude: 0}).bounds.north, 90);
  assert.equal(resolvePlusCode('2222+22', {latitude: -90, longitude: 0}).bounds.south, -90);
});

it('keeps the reference-prefix candidate at a half-cell tie and moves beyond it', () => {
  assert.equal(resolvePlusCode('2222+22', {latitude: 0.5000625, longitude: 0.5000625}).code, '6FG22222+22');
  assert.equal(resolvePlusCode('2222+22', {latitude: 0.5001625, longitude: 0.5001625}).code, '6FH32222+22');
});

it('requires a supplied finite WGS84 reference without coercion, wrapping or clipping', () => {
  assert.throws(() => resolvePlusCode('9G8F+6W'), /reference location/);
  for (const reference of [
    {}, {latitude: 47}, {latitude: '47', longitude: 8}, {latitude: 47, longitude: '8'},
    {latitude: NaN, longitude: 8}, {latitude: 47, longitude: Infinity},
    {latitude: 90.001, longitude: 8}, {latitude: -90.001, longitude: 8},
    {latitude: 47, longitude: 180.001}, {latitude: 47, longitude: -180.001}
  ]) {
    assert.throws(() => resolvePlusCode('9G8F+6W', reference), /finite WGS84/);
  }
});

it('rejects malformed short codes instead of inferring a locality or accepting padding', () => {
  const reference = {latitude: 47.365, longitude: 8.525};
  for (const code of [
    '+', '+6', 'G8F+6W', '9G8F++6W', '9G8F+6W Zurich', '9G8F+6W, CH',
    '9G80+6W', '9G00+', '9G8F+0W', '9G8F+6O', '9G8F+6Ｗ', '9G8ﬀ+6W',
    '9G8F+6W222222', '9G8F+6W' + ' '.repeat(256)
  ]) {
    assert.throws(() => resolvePlusCode(code, reference), /valid (?:short|full) Plus Code/);
  }
});
