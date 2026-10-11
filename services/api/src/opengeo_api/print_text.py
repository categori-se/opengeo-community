from dataclasses import dataclass
from functools import lru_cache
from typing import cast
from unicodedata import bidirectional, combining

from arabic_reshaper import ArabicReshaper  # type: ignore[import-untyped]
from bidi import get_base_level, get_display  # type: ignore[import-untyped]

MAX_PRINT_TEXT_CODEPOINTS = 4_096

# OpenGeo accepts natural implicit bidirectional text. Invisible author-supplied
# embeddings, overrides, isolates, and directional marks are intentionally not a
# higher-level protocol for printable content: they create spoofing and copy/paste
# ambiguity that a bounded publishing surface cannot safely communicate to readers.
_FORBIDDEN_BIDI_CONTROLS = frozenset(
    {
        "\u061c",  # ARABIC LETTER MARK
        "\u200e",  # LEFT-TO-RIGHT MARK
        "\u200f",  # RIGHT-TO-LEFT MARK
        "\u202a",  # LEFT-TO-RIGHT EMBEDDING
        "\u202b",  # RIGHT-TO-LEFT EMBEDDING
        "\u202c",  # POP DIRECTIONAL FORMATTING
        "\u202d",  # LEFT-TO-RIGHT OVERRIDE
        "\u202e",  # RIGHT-TO-LEFT OVERRIDE
        "\u2066",  # LEFT-TO-RIGHT ISOLATE
        "\u2067",  # RIGHT-TO-LEFT ISOLATE
        "\u2068",  # FIRST STRONG ISOLATE
        "\u2069",  # POP DIRECTIONAL ISOLATE
        "\u206a",  # INHIBIT SYMMETRIC SWAPPING (deprecated)
        "\u206b",  # ACTIVATE SYMMETRIC SWAPPING (deprecated)
        "\u206c",  # INHIBIT ARABIC FORM SHAPING (deprecated)
        "\u206d",  # ACTIVATE ARABIC FORM SHAPING (deprecated)
        "\u206e",  # NATIONAL DIGIT SHAPES (deprecated)
        "\u206f",  # NOMINAL DIGIT SHAPES (deprecated)
    }
)
_ZERO_WIDTH_VISUALS = frozenset({"\u200c", "\u200d", "\ufeff"})

_ARABIC_RESHAPER = ArabicReshaper(
    configuration={
        "delete_harakat": False,
        "delete_tatweel": False,
        "shift_harakat_position": True,
        "support_ligatures": True,
        "support_zwj": True,
    }
)


class PrintTextError(ValueError):
    pass


@dataclass(frozen=True, slots=True)
class PrintTextLayout:
    logical: str
    visual: str
    base_direction: str
    contains_rtl: bool


@lru_cache(maxsize=2_048)
def layout_print_text(value: str) -> PrintTextLayout:
    """Return one bounded logical string in visual glyph order for bitmap output."""

    _validate_print_text(value)
    if not value:
        return PrintTextLayout(logical="", visual="", base_direction="L", contains_rtl=False)
    try:
        shaped = _ARABIC_RESHAPER.reshape(value)
        visual = cast(str, get_display(shaped))
        base_direction = "R" if get_base_level(value) == 1 else "L"
    except (KeyError, RuntimeError, ValueError) as error:
        raise PrintTextError("site_print_text_layout_failed") from error
    visual = "".join(character for character in visual if not _is_zero_width_visual(character))
    if len(visual) > MAX_PRINT_TEXT_CODEPOINTS:
        raise PrintTextError("site_print_text_visual_limit_exceeded")
    return PrintTextLayout(
        logical=value,
        visual=visual,
        base_direction=base_direction,
        contains_rtl=any(bidirectional(character) in {"R", "AL"} for character in value),
    )


def print_text_clusters(value: str) -> tuple[str, ...]:
    """Return conservative clusters so wrapping does not split marks or joiner sequences."""

    _validate_print_text(value)
    clusters: list[str] = []
    join_next = False
    for character in value:
        if not clusters:
            clusters.append(character)
        elif (
            combining(character)
            or _is_variation_selector(character)
            or character
            in {
                "\u200c",
                "\u200d",
            }
        ):
            clusters[-1] += character
        elif join_next:
            clusters[-1] += character
            join_next = False
        else:
            clusters.append(character)
        if character == "\u200d":
            join_next = True
    return tuple(clusters)


def _validate_print_text(value: str) -> None:
    if len(value) > MAX_PRINT_TEXT_CODEPOINTS:
        raise PrintTextError("site_print_text_codepoint_limit_exceeded")
    for character in value:
        codepoint = ord(character)
        if 0xD800 <= codepoint <= 0xDFFF:
            raise PrintTextError("site_print_text_scalar_invalid")
        if character in _FORBIDDEN_BIDI_CONTROLS:
            raise PrintTextError("site_print_bidi_control_forbidden")


def _is_zero_width_visual(character: str) -> bool:
    return character in _ZERO_WIDTH_VISUALS or _is_variation_selector(character)


def _is_variation_selector(character: str) -> bool:
    codepoint = ord(character)
    return 0xFE00 <= codepoint <= 0xFE0F or 0xE0100 <= codepoint <= 0xE01EF
