import json
import tempfile
import unittest
from pathlib import Path

from pypdf import PdfWriter
from pypdf.generic import (
    ArrayObject, BooleanObject, DecodedStreamObject, DictionaryObject, NameObject,
    NumberObject,
)

from opengeo_worker.command_runner import CommandRunner
from opengeo_worker.pdf_documents import extract_pdf_semantic_preview
from opengeo_worker.pdf_tagged_text import UnsupportedTags, tagged_pages


def fixture(path: Path, fault: str | None = None) -> None:
    writer = PdfWriter()
    page = writer.add_blank_page(width=300, height=300)
    name = NameObject
    dictionary = DictionaryObject
    root = dictionary({name('/Type'): name('/StructTreeRoot')})
    root_ref = writer._add_object(root)
    doc = dictionary({
        name('/Type'): name('/StructElem'), name('/S'): name('/Document'),
        name('/P'): root_ref,
    })
    doc_ref = writer._add_object(doc)
    refs = []
    for mcid in range(2):
        refs.append(writer._add_object(dictionary({
            name('/Type'): name('/StructElem'), name('/S'): name('/P'),
            name('/P'): doc_ref, name('/Pg'): page.indirect_reference,
            name('/K'): NumberObject(mcid),
        })))
    doc[name('/K')] = ArrayObject(refs)
    root[name('/K')] = ArrayObject([doc_ref])
    parents = refs[::-1] if fault == 'parents' else refs
    root[name('/ParentTree')] = writer._add_object(dictionary({name('/Nums'): ArrayObject([
        NumberObject(0), ArrayObject(parents),
    ])}))
    page[name('/StructParents')] = NumberObject(0)
    font = writer._add_object(dictionary({
        name('/Type'): name('/Font'), name('/Subtype'): name('/Type1'),
        name('/BaseFont'): name('/Helvetica'),
    }))
    page[name('/Resources')] = dictionary({name('/Font'): dictionary({name('/F1'): font})})
    stream = DecodedStreamObject()
    chunks = []
    for i, (text, y) in enumerate([('First authored', 30), ('Second authored', 250)]):
        actual = ('\ufeff' + text).encode('utf-16-be').hex()
        chunks.append(
            f'/Span << /MCID {i} /ActualText <{actual}> >> BDC\n'
            f'BT /F1 10 Tf 20 {y} Td ({text}) Tj ET\nEMC\n'
        )
    if fault == 'unmarked':
        chunks.append('BT /F1 10 Tf 20 100 Td (Unmarked) Tj ET\n')
    stream.set_data(''.join(chunks).encode())
    page[name('/Contents')] = writer._add_object(stream)
    if fault == 'cycle':
        doc[name('/K')] = ArrayObject([doc_ref])
    if fault == 'depth':
        current = doc
        for _ in range(34):
            child = dictionary({name('/Type'): name('/StructElem'), name('/S'): name('/Sect')})
            child_ref = writer._add_object(child)
            child[name('/P')] = doc_ref if current is doc else current.indirect_reference
            current[name('/K')] = ArrayObject([child_ref])
            current = child
        current[name('/K')] = ArrayObject(refs)
    writer.root_object[name('/StructTreeRoot')] = root_ref
    writer.root_object[name('/MarkInfo')] = dictionary({name('/Marked'): BooleanObject(True)})
    writer.write(path)


class TaggedTextTests(unittest.TestCase):
    def test_actual_source_tags_override_coordinates_and_round_trip_is_deterministic(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'independent.pdf'
            fixture(path)
            before = path.read_bytes()
            self.assertEqual(tagged_pages(path, 1), [['First authored', 'Second authored']])
            runner = CommandRunner(Path(directory), timeout_seconds=10, output_bytes=1_048_576)
            preview = extract_pdf_semantic_preview(
                path, Path(directory), runner, page_count=1, pdf_version='1.3',
                title=None, language='en', tagged=True,
            )
            body = preview.path.read_bytes()
            value = json.loads(body)
            self.assertEqual(value['extraction']['readingOrder'], 'source-tags')
            self.assertEqual(value['extraction']['mode'], 'tagged-actualtext')
            self.assertEqual(value['pages'][0]['blocks'][0]['text'], 'First authored')
            extract_pdf_semantic_preview(
                path, Path(directory), runner, page_count=1, pdf_version='1.3',
                title=None, language='en', tagged=True,
            )
            self.assertEqual(preview.path.read_bytes(), body)
            self.assertEqual(path.read_bytes(), before)

    def test_bad_parent_cycle_overdepth_and_uncovered_text_fall_back(self):
        for fault in ('parents', 'cycle', 'depth', 'unmarked'):
            with self.subTest(fault=fault), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / 'unsupported.pdf'
                fixture(path, fault)
                with self.assertRaises(UnsupportedTags):
                    tagged_pages(path, 1)
                runner = CommandRunner(Path(directory), timeout_seconds=10, output_bytes=1_048_576)
                preview = extract_pdf_semantic_preview(
                    path, Path(directory), runner, page_count=1, pdf_version='1.3',
                    title=None, language='en', tagged=True,
                )
                value = json.loads(preview.path.read_bytes())
                self.assertEqual(value['extraction']['readingOrder'], 'heuristic')
                self.assertEqual(value['extraction']['engine'], 'poppler-pdftotext')
                self.assertTrue(value['pages'][0]['blocks'])


def test_rich_tagged_image_artifacts_and_vector_form_preserve_source(tmp_path):
    from pypdf import PdfReader
    from pypdf.generic import TextStringObject
    from opengeo_worker.pdf_print_vectors import prepare_vectors

    path = tmp_path / "rich.pdf"
    fixture(path)
    writer = PdfWriter()
    writer.clone_reader_document_root(PdfReader(path))
    page = writer.pages[0]
    root = writer.root_object["/StructTreeRoot"]
    doc = root["/K"][0].get_object()
    image = DecodedStreamObject()
    image.set_data(b"\xff\x00\x00")
    image.update({NameObject("/Type"): NameObject("/XObject"),
                  NameObject("/Subtype"): NameObject("/Image"),
                  NameObject("/Width"): NumberObject(1), NameObject("/Height"): NumberObject(1),
                  NameObject("/ColorSpace"): NameObject("/DeviceRGB"),
                  NameObject("/BitsPerComponent"): NumberObject(8)})
    form = DecodedStreamObject()
    form.set_data(b"0 0 10 10 re f")
    form.update({NameObject("/Type"): NameObject("/XObject"),
                 NameObject("/Subtype"): NameObject("/Form"),
                 NameObject("/BBox"): ArrayObject([NumberObject(x) for x in (0, 0, 10, 10)])})
    page["/Resources"][NameObject("/XObject")] = DictionaryObject({
        NameObject("/Im"): writer._add_object(image), NameObject("/Fm"): writer._add_object(form)})
    figure = writer._add_object(DictionaryObject({
        NameObject("/Type"): NameObject("/StructElem"), NameObject("/S"): NameObject("/Figure"),
        NameObject("/P"): doc.indirect_reference, NameObject("/Pg"): page.indirect_reference,
        NameObject("/K"): NumberObject(2), NameObject("/Alt"): TextStringObject("Red observation")
    }))
    doc["/K"].append(figure)
    root["/ParentTree"]["/Nums"][1].append(figure)
    stream = DecodedStreamObject()
    stream.set_data(page.get_contents().get_data() + b"\n/Artifact BMC /Fm Do EMC\n/Figure <</MCID 2>> BDC /Im Do EMC\n")
    page[NameObject("/Contents")] = writer._add_object(stream)
    writer.write(path)
    original = path.read_bytes()
    expected = [["First authored", "Second authored", "Red observation"]]
    assert tagged_pages(path, 1) == expected
    target = tmp_path / "prepared.pdf"
    assert prepare_vectors(path, target, 1)["source_tags"] == "closed-actualtext"
    assert tagged_pages(target, 1) == expected
    assert PdfReader(target).pages[0].get_contents().get_data() == PdfReader(path).pages[0].get_contents().get_data()
    assert path.read_bytes() == original


def test_marked_glyph_order_is_source_order_without_claiming_actualtext_print_profile(tmp_path):
    import re
    from pypdf import PdfReader
    path = tmp_path / "glyphs.pdf"
    fixture(path)
    writer = PdfWriter()
    writer.clone_reader_document_root(PdfReader(path))
    page = writer.pages[0]
    stream = DecodedStreamObject()
    stream.set_data(re.sub(rb" /ActualText <[0-9a-f]+>", b"", page.get_contents().get_data()))
    page[NameObject("/Contents")] = writer._add_object(stream)
    writer.write(path)
    assert tagged_pages(path, 1) == [["First authored", "Second authored"]]
    with __import__("pytest").raises(UnsupportedTags):
        tagged_pages(path, 1, require_actual_text=True)


def test_marked_font_text_preparation_records_truthful_source_profile(tmp_path):
    from opengeo_worker.pdf_print_vectors import prepare_vectors
    from pypdf import PdfReader
    import re
    source = tmp_path / "font-source.pdf"
    fixture(source)
    writer = PdfWriter()
    writer.clone_reader_document_root(PdfReader(source))
    page = writer.pages[0]
    stream = DecodedStreamObject()
    stream.set_data(re.sub(rb" /ActualText <[0-9a-f]+>", b"", page.get_contents().get_data()))
    page[NameObject("/Contents")] = writer._add_object(stream)
    writer.write(source)
    before = source.read_bytes()
    target = tmp_path / "font-prepared.pdf"
    assert prepare_vectors(source, target, 1)["source_tags"] == "validated-mcid-text"
    assert tagged_pages(target, 1) == [["First authored", "Second authored"]]
    runner = CommandRunner(tmp_path, timeout_seconds=10, output_bytes=1_048_576)
    preview = extract_pdf_semantic_preview(
        source, tmp_path, runner, page_count=1, pdf_version="1.3",
        title=None, language="en", tagged=True,
    )
    value = json.loads(preview.path.read_bytes())
    assert value["extraction"]["readingOrder"] == "source-tags"
    assert value["extraction"]["mode"] == "tagged-mcid-text"
    assert [block["text"] for block in value["pages"][0]["blocks"]] == [
        "First authored", "Second authored"
    ]
    assert source.read_bytes() == before


def test_unmapped_font_and_malformed_markers_never_gain_source_authority(tmp_path):
    import re
    import pytest
    from pypdf import PdfReader

    for fault in ("font", "encoding", "bmc", "bdc"):
        source = tmp_path / f"invalid-{fault}.pdf"
        fixture(source)
        writer = PdfWriter()
        writer.clone_reader_document_root(PdfReader(source))
        page = writer.pages[0]
        data = re.sub(rb" /ActualText <[0-9a-f]+>", b"", page.get_contents().get_data())
        font = page["/Resources"]["/Font"]["/F1"]
        if fault == "font":
            font[NameObject("/BaseFont")] = NameObject("/CustomGlyphs")
        elif fault == "encoding":
            font[NameObject("/Encoding")] = DictionaryObject({
                NameObject("/Differences"): ArrayObject([NumberObject(65), NameObject("/Z")])
            })
        elif fault == "bmc":
            data += b"\n/Artifact /Unexpected BMC EMC\n"
        else:
            data += b"\n/Artifact <<>> /Unexpected BDC EMC\n"
        stream = DecodedStreamObject()
        stream.set_data(data)
        page[NameObject("/Contents")] = writer._add_object(stream)
        writer.write(source)
        with pytest.raises(UnsupportedTags):
            tagged_pages(source, 1)


def test_empty_text_operators_cannot_invent_actualtext_content(tmp_path):
    import re
    import pytest
    from pypdf import PdfReader

    for replacement in (b"() Tj", b"[120 -40] TJ"):
        source = tmp_path / "empty-paint.pdf"
        fixture(source)
        writer = PdfWriter()
        writer.clone_reader_document_root(PdfReader(source))
        page = writer.pages[0]
        stream = DecodedStreamObject()
        stream.set_data(re.sub(rb"\([^)]*\) Tj", replacement, page.get_contents().get_data()))
        page[NameObject("/Contents")] = writer._add_object(stream)
        writer.write(source)
        with pytest.raises(UnsupportedTags):
            tagged_pages(source, 1)
