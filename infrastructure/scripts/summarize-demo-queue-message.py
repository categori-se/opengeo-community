"""Offline, redacted inspection of one saved SQS response. Never calls AWS."""

import argparse
import hashlib
import json
import os
from datetime import datetime
from pathlib import Path

MAX_RESPONSE_BYTES = 131_072
MAX_BODY_BYTES = 65_536
TEST_KEYS = {"Service", "Event", "Time", "Bucket", "RequestId", "HostId"}


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate_json_key")
        result[key] = value
    return result


def reject_non_json_number(_):
    raise ValueError("non_json_number")


def decode(value):
    return json.loads(value, object_pairs_hook=unique_object,
                      parse_constant=reject_non_json_number)


def private_opener(path, flags):
    return os.open(path, flags, 0o600)


def digest(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def summarize(response):
    if not isinstance(response, dict):
        raise ValueError("invalid_sqs_response")
    messages = response.get("Messages", [])
    if not isinstance(messages, list) or len(messages) > 1:
        raise ValueError("expected_at_most_one_message")
    result = {"schemaVersion": "opengeo.demo-queue-inspection.1", "awsCalls": 0,
              "deletionAuthorized": False, "processingAuthorized": False}
    if not messages:
        return {**result, "classification": "no-message-returned", "queueEmptyProven": False}
    message = messages[0]
    if not isinstance(message, dict):
        raise ValueError("invalid_message_envelope")
    body, message_id = message.get("Body"), message.get("MessageId")
    if not isinstance(body, str) or not 1 <= len(body.encode("utf-8")) <= MAX_BODY_BYTES:
        raise ValueError("invalid_message_body_size")
    if not isinstance(message_id, str) or not 1 <= len(message_id) <= 128:
        raise ValueError("invalid_message_identity")
    actual_md5 = hashlib.md5(body.encode("utf-8"), usedforsecurity=False).hexdigest()
    if message.get("MD5OfBody") != actual_md5:
        raise ValueError("message_body_checksum_mismatch")
    attributes = message.get("Attributes")
    if not isinstance(attributes, dict):
        raise ValueError("message_attributes_missing")
    count = attributes.get("ApproximateReceiveCount")
    if not isinstance(count, str) or not count.isascii() or not count.isdigit() or not 1 <= len(count) <= 8 or int(count) < 1:
        raise ValueError("receive_count_missing")
    result.update({"bodySha256": digest(body), "messageIdSha256": digest(message_id),
                   "bodyBytes": len(body.encode("utf-8")), "approximateReceiveCount": int(count),
                   "classification": "requires-review", "provenanceAuthenticated": False})
    try:
        payload = decode(body)
    except (ValueError, RecursionError):
        return result
    if not isinstance(payload, dict) or set(payload) != TEST_KEYS:
        return result
    if payload.get("Service") != "Amazon S3" or payload.get("Event") != "s3:TestEvent" or payload.get("Bucket") != "demo.storage.opengeo.tools":
        return result
    if any(not isinstance(payload[key], str) or not 1 <= len(payload[key]) <= 2048 for key in TEST_KEYS):
        return result
    try:
        if not payload["Time"].endswith("Z") or len(payload["Time"]) > 40:
            return result
        datetime.fromisoformat(payload["Time"].replace("Z", "+00:00"))
    except ValueError:
        return result
    result["classification"] = "matches-demo-s3-test-shape"
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--response", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()
    try:
        with args.response.open("rb") as source:
            raw = source.read(MAX_RESPONSE_BYTES + 1)
        if len(raw) > MAX_RESPONSE_BYTES:
            raise ValueError("response_too_large")
        result = summarize(decode(raw))
        with open(args.out, "x", encoding="utf-8", opener=private_opener) as destination:
            destination.write(json.dumps(result, indent=2) + "\n")
        print(json.dumps(result))
    except (ValueError, TypeError, OSError, RecursionError):
        raise SystemExit("Queue response could not be summarized safely; no body or receipt handle is printed.") from None


if __name__ == "__main__":
    main()
