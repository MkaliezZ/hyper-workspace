"""Synthetic in-memory files for product integration and real source CI."""
import io
import sys

kind, text = sys.argv[1:3]
output = io.BytesIO()
if kind == "pdf":
    from pypdf import PdfWriter
    from pypdf.generic import DictionaryObject, NameObject, DecodedStreamObject
    writer = PdfWriter()
    page = writer.add_blank_page(300, 300)
    font = DictionaryObject({NameObject("/Type"): NameObject("/Font"), NameObject("/Subtype"): NameObject("/Type1"), NameObject("/BaseFont"): NameObject("/Helvetica")})
    page[NameObject("/Resources")] = DictionaryObject({NameObject("/Font"): DictionaryObject({NameObject("/F1"): font})})
    stream = DecodedStreamObject()
    # Test tokens are intentionally ASCII alphabetic, with no PDF syntax.
    if not text.replace("-", "").isalnum() or not text.isascii():
        raise ValueError("Synthetic fixture token only")
    stream.set_data(f"BT /F1 12 Tf 20 100 Td ({text}) Tj ET".encode())
    page[NameObject("/Contents")] = writer._add_object(stream)
    writer.write(output)
elif kind == "docx":
    from docx import Document
    document = Document()
    document.add_paragraph(text)
    document.add_table(rows=1, cols=1).cell(0, 0).text = "Synthetic table fact"
    document.save(output)
elif kind == "xlsx":
    from openpyxl import Workbook
    workbook = Workbook()
    workbook.active["B2"] = text
    workbook.active["C3"] = "=1+1"
    workbook.save(output)
elif kind == "pptx":
    from pptx import Presentation
    from pptx.util import Inches
    presentation = Presentation()
    slide = presentation.slides.add_slide(presentation.slide_layouts[6])
    slide.shapes.add_textbox(0, 0, Inches(3), Inches(1)).text = text
    presentation.save(output)
else:
    raise ValueError("Unknown fixture format")
sys.stdout.buffer.write(output.getvalue())
