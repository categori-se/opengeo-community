from hashlib import sha256
from io import BytesIO
from pathlib import Path
from uuid import UUID

import pytest
from pypdf import PdfReader, PdfWriter
from pypdf.generic import (
    ArrayObject,
    DecodedStreamObject,
    DictionaryObject,
    NameObject,
    NumberObject,
    TextStringObject,
)

from opengeo_api.pdf_print_documents import (
    MAX_DOCUMENT_BYTES,
    PdfPrintDocumentError,
    compose_vector_pages,
    describe_vector_documents,
)

IDENTITY = UUID("00000000-0000-0000-0000-000000000001")


def _dictionary(**items):
    return DictionaryObject({NameObject("/" + key): value for key, value in items.items()})


def _pdf(texts, *, prepared=False, tagged=False, rotated=False, annotation=False):
    writer = PdfWriter()
    root = writer._root_object
    sections = ArrayObject()
    nums = ArrayObject()
    structure = _dictionary(Type=NameObject("/StructTreeRoot"))
    structure_ref = writer._add_object(structure)
    document = _dictionary(
        Type=NameObject("/StructElem"), S=NameObject("/Document"), P=structure_ref, K=sections
    )
    document_ref = writer._add_object(document)
    for index, text in enumerate(texts):
        page = writer.add_blank_page(300, 400)
        if rotated:
            page[NameObject("/CropBox")] = ArrayObject(
                [NumberObject(n) for n in [10, 20, 210, 320]]
            )
            page[NameObject("/Rotate")] = NumberObject(90)
        font = writer._add_object(
            _dictionary(
                Type=NameObject("/Font"),
                Subtype=NameObject("/Type1"),
                BaseFont=NameObject("/Helvetica"),
            )
        )
        page[NameObject("/Resources")] = _dictionary(Font=_dictionary(F1=font))
        content = DecodedStreamObject()
        body = f"0 0.7 0 rg 20 30 70 80 re f BT /F1 12 Tf 30 200 Td ({text}) Tj ET" if text else ""
        if tagged and text:
            body = f"/Span <</MCID 0 /ActualText ({text})>> BDC {body} EMC"
        content.set_data(body.encode("ascii"))
        page[NameObject("/Contents")] = writer._add_object(content)
        if tagged:
            page[NameObject("/StructParents")] = NumberObject(index)
            children = ArrayObject()
            section = _dictionary(
                Type=NameObject("/StructElem"),
                S=NameObject("/Sect"),
                P=document_ref,
                Pg=page.indirect_reference,
                K=children,
            )
            section_ref = writer._add_object(section)
            if text:
                children.append(
                    writer._add_object(
                        _dictionary(
                            Type=NameObject("/StructElem"),
                            S=NameObject("/Span"),
                            P=section_ref,
                            Pg=page.indirect_reference,
                            K=NumberObject(0),
                        )
                    )
                )
            sections.append(section_ref)
            nums.extend([NumberObject(index), ArrayObject(children)])
        if annotation:
            page[NameObject("/Annots")] = ArrayObject(
                [
                    writer._add_object(
                        _dictionary(
                            Type=NameObject("/Annot"),
                            Subtype=NameObject("/Link"),
                            A=_dictionary(
                                S=NameObject("/JavaScript"), JS=TextStringObject("app.alert(1)")
                            ),
                        )
                    )
                ]
            )
    if tagged:
        structure[NameObject("/K")] = ArrayObject([document_ref])
        structure[NameObject("/ParentTree")] = writer._add_object(_dictionary(Nums=nums))
        structure[NameObject("/ParentTreeNextKey")] = NumberObject(len(texts))
        root[NameObject("/StructTreeRoot")] = structure_ref
    if prepared:
        root[NameObject("/OpenGeoPrintVector")] = TextStringObject("1.0.0")
    output = BytesIO()
    writer.write(output)
    return output.getvalue()


def test_vector_font_crop_rotation_and_generated_tags_survive():
    source = _pdf(["selectable source"], prepared=True, rotated=True)
    base = _pdf(["generated before", "", "generated after"], tagged=True)
    documents = {IDENTITY: source}
    metadata = describe_vector_documents(documents)[str(IDENTITY)][0]
    assert (metadata["width"], metadata["height"], metadata["rotation"]) == (300, 200, 90)
    placement = [{"targetPageIndex": 1, "objectID": str(IDENTITY), "sourcePageIndex": 0}]
    result = compose_vector_pages(base, documents, placement)
    assert result == compose_vector_pages(base, documents, placement)
    output = PdfReader(BytesIO(result))
    assert [page.extract_text() for page in output.pages] == [
        "generated before",
        "selectable source",
        "generated after",
    ]
    imported = output.pages[1]
    assert imported["/Rotate"] == 90
    assert list(imported.cropbox) == [10, 20, 210, 320]
    assert b"0 0.7 0 rg 20 30 70 80 re f" in imported.get_contents().get_data()
    assert imported["/Resources"]["/Font"]["/F1"]["/BaseFont"] == "/Helvetica"
    structure = output.root_object["/StructTreeRoot"]
    sections = structure["/K"][0].get_object()["/K"]
    for index in (0, 2):
        section = sections[index].get_object()
        assert section.raw_get("/Pg") == output.pages[index].indirect_reference
        span = section["/K"][0].get_object()
        assert span.raw_get("/Pg") == output.pages[index].indirect_reference
    assert source == documents[IDENTITY]


@pytest.mark.parametrize("repetitions", [1, 2])
def test_imported_closed_actualtext_tags_retain_order_and_page_references(repetitions):
    source = _pdf(["source one", "source two"], prepared=True, tagged=True)
    base = _pdf(["before", *([""] * (2 * repetitions)), "after"], tagged=True)
    placements = [
        {"targetPageIndex": index + 1, "objectID": str(IDENTITY), "sourcePageIndex": index % 2}
        for index in range(2 * repetitions)
    ]
    output = PdfReader(BytesIO(compose_vector_pages(base, {IDENTITY: source}, placements)))
    structure = output.root_object["/StructTreeRoot"]
    document = structure["/K"][0].get_object()
    sections = document["/K"]
    nums = structure["/ParentTree"]["/Nums"]
    for index in range(1, 2 * repetitions + 1):
        placeholder = sections[index].get_object()
        assert placeholder.raw_get("/P") == document.indirect_reference
        section = placeholder["/K"][0].get_object()
        assert section["/S"] == "/Sect"
        assert section.raw_get("/P") == placeholder.indirect_reference
        assert section.raw_get("/Pg") == output.pages[index].indirect_reference
        span_ref = section["/K"][0]
        span = span_ref.get_object()
        assert span.raw_get("/P") == section.indirect_reference
        assert span.raw_get("/Pg") == output.pages[index].indirect_reference
        assert nums[index * 2 + 1][0] == span_ref


def test_active_annotation_unprepared_and_nonempty_placeholder_rejected():
    source = _pdf(["source"], prepared=True)
    for unsafe in (_pdf(["source"], prepared=True, annotation=True), _pdf(["source"])):
        with pytest.raises(PdfPrintDocumentError):
            describe_vector_documents({IDENTITY: unsafe})
    with pytest.raises(PdfPrintDocumentError):
        compose_vector_pages(
            _pdf(["existing text"]),
            {IDENTITY: source},
            [{"targetPageIndex": 0, "objectID": str(IDENTITY), "sourcePageIndex": 0}],
        )


def test_host_limits_and_no_document_passthrough():
    assert describe_vector_documents({}) == {}
    assert compose_vector_pages(b"unchanged", {}, []) == b"unchanged"
    with pytest.raises(PdfPrintDocumentError):
        describe_vector_documents({IDENTITY: b"x" * (MAX_DOCUMENT_BYTES + 1)})


def prepared_vector_fixture() -> bytes:
    # Exact output of the worker's real tagged vector fixture and prepare_vectors;
    # includes Helvetica text, a colored path, crop/rotation and original P roles.
    body = (Path(__file__).parent / "fixtures" / "pdf-print-vector.pdf").read_bytes()
    assert (
        sha256(body).hexdigest()
        == "ac69d6833703aa9e36c03d2020fc62b9a63da04e8c71c1c53a3df4664366c9b3"
    )
    return body


def test_tagged_artifact_vector_form_and_direct_mcid_array_round_trip():
    source = PdfReader(BytesIO(_pdf(["authored source"], prepared=True, tagged=True)))
    writer = PdfWriter()
    writer.clone_reader_document_root(source)
    page = writer.pages[0]
    form = DecodedStreamObject()
    form.set_data(b"0 0 10 10 re f")
    form.update(_dictionary(Type=NameObject("/XObject"), Subtype=NameObject("/Form"),
                            BBox=ArrayObject([NumberObject(x) for x in (0, 0, 10, 10)])))
    page["/Resources"][NameObject("/XObject")] = _dictionary(Fm=writer._add_object(form))
    content = DecodedStreamObject()
    content.set_data(page.get_contents().get_data() + b"\n/Artifact BMC /Fm Do EMC\n")
    page[NameObject("/Contents")] = writer._add_object(content)
    leaf = writer.root_object["/StructTreeRoot"]["/K"][0].get_object()["/K"][0].get_object()["/K"][0].get_object()
    leaf[NameObject("/K")] = ArrayObject([NumberObject(0)])
    output = BytesIO()
    writer.write(output)
    result = compose_vector_pages(_pdf([""], tagged=True), {IDENTITY: output.getvalue()},
                                  [{"targetPageIndex": 0, "objectID": str(IDENTITY), "sourcePageIndex": 0}])
    expected_page = PdfReader(BytesIO(output.getvalue())).pages[0]
    result_page = PdfReader(BytesIO(result)).pages[0]
    assert result_page.extract_text() == expected_page.extract_text()
    assert result_page.get_contents().get_data() == expected_page.get_contents().get_data()
