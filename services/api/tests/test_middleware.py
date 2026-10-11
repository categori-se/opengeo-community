from opengeo_api.middleware import safe_request_id


def test_request_id_rejects_empty_and_oversized_values() -> None:
    assert safe_request_id("") != ""
    assert safe_request_id("x" * 129) != "x" * 129


def test_request_id_accepts_documented_safe_characters() -> None:
    value = "alb.request-1/attempt:2"

    assert safe_request_id(value) == value
