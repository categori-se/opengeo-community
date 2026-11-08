import hashlib
import tempfile
import unittest
from pathlib import Path

from pypdf import PdfReader, PdfWriter
from pypdf.generic import (
    ArrayObject,
    DecodedStreamObject,
    DictionaryObject,
    NameObject,
    NumberObject,
    RectangleObject,
    TextStringObject,
)

from opengeo_worker.pdf_print_vectors import UnsupportedVectors, prepare_vectors
from opengeo_worker.pdf_tagged_text import tagged_pages
from test_pdf_tagged_text import fixture


def vector_fixture(path: Path, *, active: bool = False) -> None:
    # Real Helvetica text/font and colored vector path; retain the existing
    # authoritative reading-order fixture rather than synthesizing tag claims.
    fixture(path)
    reader = PdfReader(path)
    writer = PdfWriter(clone_from=reader)
    page = writer.pages[0]
    page.cropbox = RectangleObject([10, 15, 290, 280])
    page[NameObject("/Rotate")] = NumberObject(90)
    content = page.get_contents().get_data()
    stream = DecodedStreamObject()
    stream.set_data(content + b"0.85 0.1 0.2 rg 40 60 70 90 re f\n")
    page[NameObject("/Contents")] = writer._add_object(stream)
    annotation = DictionaryObject(
        {
            NameObject("/Type"): NameObject("/Annot"),
            NameObject("/Subtype"): NameObject("/Text"),
            NameObject("/Rect"): RectangleObject([40, 40, 80, 80]),
            NameObject("/Contents"): TextStringObject("ANNOTATION_CONTROL"),
        }
    )
    if active:
        annotation[NameObject("/A")] = DictionaryObject(
            {
                NameObject("/S"): NameObject("/URI"),
                NameObject("/URI"): TextStringObject("https://example.invalid/blocked"),
            }
        )
    page[NameObject("/Annots")] = ArrayObject([writer._add_object(annotation)])
    writer.write(path)


class PrintVectorTests(unittest.TestCase):
    def test_real_text_paths_crop_rotation_tags_and_annotation_policy(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.pdf"
            first = Path(directory) / "first.pdf"
            second = Path(directory) / "second.pdf"
            vector_fixture(source)
            before = source.read_bytes()
            facts = prepare_vectors(source, first, 1)
            prepare_vectors(source, second, 1)
            self.assertEqual(first.read_bytes(), second.read_bytes())
            self.assertEqual(source.read_bytes(), before)
            self.assertEqual(facts["annotations_removed"], 1)
            self.assertEqual(facts["source_tags"], "closed-actualtext")
            self.assertEqual(tagged_pages(first, 1), [["First authored", "Second authored"]])
            output = PdfReader(first)
            page = output.pages[0]
            self.assertEqual(str(output.root_object["/OpenGeoPrintVector"]), "1.0.0")
            self.assertNotIn("/Annots", page)
            self.assertEqual(list(page.cropbox), [10, 15, 290, 280])
            self.assertEqual(page.rotation, 90)
            operators = page.get_contents().get_data()
            self.assertIn(b" re f", operators)
            self.assertIn(b" Tj", operators)
            self.assertIn("/Font", page["/Resources"])
            self.assertNotIn(b"ANNOTATION_CONTROL", first.read_bytes())
            self.assertIn("First authored", page.extract_text())
            self.assertEqual(
                hashlib.sha256(before).digest(),
                hashlib.sha256(source.read_bytes()).digest(),
            )

    def test_parsed_active_annotation_refused_without_source_mutation(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "active.pdf"
            vector_fixture(source, active=True)
            before = source.read_bytes()
            with self.assertRaises(UnsupportedVectors):
                prepare_vectors(source, Path(directory) / "prepared.pdf", 1)
            self.assertEqual(before, source.read_bytes())


if __name__ == "__main__":
    unittest.main()
