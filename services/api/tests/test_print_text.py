import pytest

from opengeo_api.print_text import (
    MAX_PRINT_TEXT_CODEPOINTS,
    PrintTextError,
    layout_print_text,
    print_text_clusters,
)


def test_orders_mixed_hebrew_and_numbers_without_changing_logical_text() -> None:
    logical = "OpenGeo: שלום 123"

    layout = layout_print_text(logical)

    assert layout.logical == logical
    assert layout.visual == "OpenGeo: 123 םולש"
    assert layout.base_direction == "L"


def test_shapes_and_orders_arabic_persian_and_urdu_presentation_forms() -> None:
    arabic = layout_print_text("OpenGeo: مرحبا بالعالم 123")
    persian = layout_print_text("فارسی ۱۲۳")
    urdu = layout_print_text("اردو ۱۲۳")

    assert arabic.visual == "OpenGeo: 123 ﻢﻟﺎﻌﻟﺎﺑ ﺎﺒﺣﺮﻣ"
    assert persian.visual == "۱۲۳ ﯽﺳﺭﺎﻓ"
    assert urdu.visual == "۱۲۳ ﻭﺩﺭﺍ"
    assert persian.base_direction == urdu.base_direction == "R"


def test_removes_zero_width_joiners_only_from_visual_glyph_output() -> None:
    logical = "A\u200dB e\u0301"

    layout = layout_print_text(logical)

    assert layout.logical == logical
    assert layout.visual == "AB e\u0301"
    assert print_text_clusters(logical) == ("A\u200dB", " ", "e\u0301")


@pytest.mark.parametrize(
    "control",
    [
        "\u061c",
        "\u200e",
        "\u200f",
        "\u202a",
        "\u202b",
        "\u202c",
        "\u202d",
        "\u202e",
        "\u2066",
        "\u2067",
        "\u2068",
        "\u2069",
        "\u206a",
        "\u206b",
        "\u206c",
        "\u206d",
        "\u206e",
        "\u206f",
    ],
)
def test_rejects_invisible_bidi_controls(control: str) -> None:
    with pytest.raises(PrintTextError, match="site_print_bidi_control_forbidden"):
        layout_print_text(f"safe{control}spoof")


def test_rejects_non_scalar_and_oversized_input() -> None:
    with pytest.raises(PrintTextError, match="site_print_text_scalar_invalid"):
        layout_print_text("bad\ud800")
    with pytest.raises(PrintTextError, match="site_print_text_codepoint_limit_exceeded"):
        layout_print_text("x" * (MAX_PRINT_TEXT_CODEPOINTS + 1))
