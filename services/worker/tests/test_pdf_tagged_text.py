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
