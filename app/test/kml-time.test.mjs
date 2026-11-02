import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {isKmlTimeSpanReversed, isValidKmlTimeValue} from "../src/lib/kmlTime.js";

describe("KML calendar values and conservative span ordering", () => {
  it("accepts real Gregorian dates, all four precisions, zones, and exact fractions", () => {
    // XSD 1.0 Appendix E uses divisibility of the signed year field for leap days.
    for (const value of [
      "0001", "-0001", "10000", "-10000", "123456789012345678901234567890",
      "2026Z", "2026+14:00", "2026-14:00", "2026-08", "2026-08Z", "2026-08-14:00",
      "2000-02-29", "2024-02-29Z", "1900-02-28", "-0004-02-29", "-0001-02-28",
      "2026-08-24+14:00", "2026-08-24-14:00", "2026-08-24+00:00", "2026-08-24-00:00",
      "2026-08-24T00:00:00", "2026-08-24T23:59:59-13:59", "2026-08-24T12:00:00+14:00",
      "2026-12-31T24:00:00", "2026-12-31T24:00:00.0000Z",
      "2016-12-31T23:59:60.5Z", "2026-08-24T12:00:60",
      "2026-08-24T12:00:00.123456789012345678901234567890Z"
    ]) assert.equal(isValidKmlTimeValue(value), true, value);
  });

  it("rejects invalid year, calendar, clock, and timezone values", () => {
    for (const value of [
      "0000", "-0000", "01234", "-01234", "+2026", "026", "2026-00", "2026-13",
      "2026-01-00", "2026-01-32", "2026-04-31", "2026-02-29", "1900-02-29", "2100-02-29", "-0001-02-29",
      "2026-08-24T25:00:00", "2026-08-24T24:01:00", "2026-08-24T24:00:01",
      "2026-08-24T24:00:00.0001", "2026-08-24T24:00:60", "2026-08-24T12:60:00", "2026-08-24T12:00:61",
      "2026-08-24T12:00", "2026-08-24T12:00:00.", "2026-08-24t12:00:00Z", "2026-08-24T12:00:00z",
      "2026+14:01", "2026-15:00", "2026-08+00:60", "2026-08-24+15:00", "2026-08-24-14:01",
      "2026-08-24T12:00:00+24:00", "2026-08-24T12:00:00+01:60", "2026-08-24T12:00:00+1:00",
      "2026-08-24 12:00:00Z", "tomorrow", "", null
    ]) assert.equal(isValidKmlTimeValue(value), false, String(value));
  });

  it("rejects definitely reversed calendar bounds without assuming mixed precision", () => {
    for (const [begin, end] of [
      ["2027", "2026"], ["2026-09", "2026-08"], ["2026-08-25", "2026-08-24"],
      ["2027-01-01", "2026"], ["2026-08-24T12:00:00", "2026-08-24T11:00:00"],
      ["0001", "-0001"], ["123456789012345678901234567891", "123456789012345678901234567890"]
    ]) assert.equal(isKmlTimeSpanReversed(begin, end), true, `${begin} / ${end}`);
    for (const [begin, end] of [
      ["2026", "2026"], ["2026-12", "2026"], ["2026-08-24T12:00:00", "2026-08-24"],
      ["2026-08-31", "2026-08"], ["2026", "2026-01-01"], ["-0001", "0001"]
    ]) assert.equal(isKmlTimeSpanReversed(begin, end), false, `${begin} / ${end}`);
  });

  it("compares explicit offsets and arbitrary fractional precision exactly", () => {
    assert.equal(isKmlTimeSpanReversed("2026-08-24T10:00:00-02:00", "2026-08-24T11:00:00Z"), true);
    assert.equal(isKmlTimeSpanReversed("2026-08-24T10:00:00+02:00", "2026-08-24T09:00:00Z"), false);
    assert.equal(isKmlTimeSpanReversed("2026-08-24T12:00:00.100000000000000000000000000001Z", "2026-08-24T12:00:00.1Z"), true);
    assert.equal(isKmlTimeSpanReversed("2026-08-24T12:00:00.1000Z", "2026-08-24T12:00:00.1+00:00"), false);
    assert.equal(isKmlTimeSpanReversed("2026-08-24T12:00:00.099999999999999999999999999999Z", "2026-08-24T12:00:00.1Z"), false);
    assert.equal(isKmlTimeSpanReversed("2026-12-31T24:00:00.000Z", "2027-01-01T00:00:00Z"), false);
    assert.equal(isKmlTimeSpanReversed("-0001-12-31T24:00:00Z", "0001-01-01T00:00:00Z"), false);
    assert.equal(isKmlTimeSpanReversed("-0004-02-29T24:00:00Z", "-0004-03-01T00:00:00Z"), false);
    assert.equal(isKmlTimeSpanReversed("123456789012345678901234567890-12-31T24:00:00Z", "123456789012345678901234567891-01-01T00:00:00Z"), false);
    assert.equal(isKmlTimeSpanReversed("2016-12-31T23:59:60.9Z", "2017-01-01T00:00:00.1Z"), false);
    assert.equal(isKmlTimeSpanReversed("2017-01-01T00:00:02Z", "2016-12-31T23:59:60Z"), true);
    assert.equal(isKmlTimeSpanReversed("2016-12-31T23:59:60.9Z", "2016-12-31T23:59:60.1Z"), true);
    assert.equal(isKmlTimeSpanReversed("2016-12-31T23:59:60.1Z", "2016-12-31T23:59:60.9Z"), false);
    assert.equal(isKmlTimeSpanReversed("2017-01-01T00:59:60.9+01:00", "2016-12-31T23:59:60.1Z"), true);
    assert.equal(isKmlTimeSpanReversed("2016-12-31T23:59:60.9", "2017-01-01T00:00:00.1"), false);
    assert.equal(isKmlTimeSpanReversed("2016-12-31T23:59:60.9", "2016-12-31T23:59:60.1"), true);
  });

  it("retains ambiguous missing zones and mixed calendar precision", () => {
    for (const [begin, end] of [
      ["2026-08-24T12:00:00", "2026-08-24T11:00:00Z"],
      ["2026-08-24T12:00:00Z", "2026-08-24T11:00:00"],
      ["2026-08-25T01:00:00", "2026-08-24T11:00:00Z"],
      ["2026-08-25T00:30:00Z", "2026-08-24-14:00"],
      ["2026-08-25+14:00", "2026-08-24-14:00"]
    ]) assert.equal(isKmlTimeSpanReversed(begin, end), false, `${begin} / ${end}`);
    assert.equal(isKmlTimeSpanReversed("2026-08-25T02:00:00", "2026-08-24T11:00:00Z"), true);
    assert.equal(isKmlTimeSpanReversed("2026-08-25T02:00:00Z", "2026-08-24T11:00:00"), true);
    assert.equal(isKmlTimeSpanReversed("2026-08-26", "2026-08-24Z"), true);
  });
});
