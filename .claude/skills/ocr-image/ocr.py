#!/usr/bin/env python3
"""OCR helper — extract text from images for LLM semantic analysis."""

import sys, os, json, argparse
from pathlib import Path

def setup_tesseract():
    import pytesseract
    tesseract_path = r"C:\Program Files\Tesseract-OCR\tesseract.exe"
    if not Path(tesseract_path).exists():
        # Fallback: search PATH
        import shutil
        found = shutil.which("tesseract")
        if found:
            tesseract_path = found
    pytesseract.pytesseract.tesseract_cmd = tesseract_path
    # Use user-writable tessdata
    user_tessdata = Path.home() / "tesseract" / "tessdata"
    if user_tessdata.exists():
        os.environ["TESSDATA_PREFIX"] = str(user_tessdata)
    return pytesseract

def ocr_image(image_path: str, lang: str = "eng+chi_sim") -> str:
    """Extract text from an image file using Tesseract OCR."""
    from PIL import Image
    pytesseract = setup_tesseract()
    img = Image.open(image_path)
    text = pytesseract.image_to_string(img, lang=lang)
    return text.strip()

def ocr_pdf(pdf_path: str, lang: str = "eng+chi_sim", dpi: int = 200) -> str:
    """Extract text from a PDF by converting each page to images and OCRing."""
    from pdf2image import convert_from_path
    pytesseract = setup_tesseract()
    images = convert_from_path(pdf_path, dpi=dpi)
    all_text = []
    for i, img in enumerate(images, 1):
        text = pytesseract.image_to_string(img, lang=lang).strip()
        if text:
            all_text.append(f"--- Page {i} ---\n{text}")
    return "\n\n".join(all_text)

def main():
    parser = argparse.ArgumentParser(description="OCR images/PDFs for LLM analysis")
    parser.add_argument("input", help="Path to image or PDF file")
    parser.add_argument("--lang", default="eng+chi_sim", help="Tesseract language codes (default: eng+chi_sim)")
    parser.add_argument("--dpi", type=int, default=200, help="DPI for PDF rendering (default: 200)")
    parser.add_argument("--json", action="store_true", help="Output as JSON with metadata")
    args = parser.parse_args()

    path = Path(args.input)
    if not path.exists():
        print(json.dumps({"error": f"File not found: {args.input}"}))
        sys.exit(1)

    suffix = path.suffix.lower()
    if suffix in (".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tiff"):
        text = ocr_image(str(path), args.lang)
    elif suffix == ".pdf":
        text = ocr_pdf(str(path), args.lang, args.dpi)
    else:
        print(json.dumps({"error": f"Unsupported format: {suffix}"}))
        sys.exit(1)

    if args.json:
        print(json.dumps({
            "file": str(path),
            "pages": text.count("--- Page") or 1,
            "characters": len(text),
            "text": text
        }, ensure_ascii=False))
    else:
        print(text)

if __name__ == "__main__":
    main()
