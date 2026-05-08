---
name: ocr-image
description: Extract text from images and PDFs via local OCR (Tesseract), then feed to LLM for semantic analysis. Use when the user asks to read text from a screenshot, photo, or scanned PDF, or needs to understand image content through OCR.
---

# OCR Image Skill

Extract readable text from images and scanned PDFs using local Tesseract OCR, then analyze the text semantically with the LLM.

## Workflow

1. **Read the image** — user provides a file path, screenshot, or photo
2. **Run OCR** — use the helper script to extract text
3. **Analyze** — feed extracted text to LLM for interpretation, summarization, or Q&A

## Usage

### Single Image OCR

```bash
python ${CLAUDE_SKILL_DIR}/ocr.py path/to/image.png --lang eng+chi_sim
```

Output goes to stdout as plain text. The LLM then reads this text and provides analysis.

### Scanned PDF OCR

```bash
python ${CLAUDE_SKILL_DIR}/ocr.py path/to/scanned.pdf --lang eng+chi_sim --dpi 200
```

Each page is rendered to an image and OCR'd. Higher DPI improves accuracy at the cost of speed.

### JSON Output (for programmatic use)

```bash
python ${CLAUDE_SKILL_DIR}/ocr.py path/to/image.png --json
```

Returns `{"file": "...", "pages": 1, "characters": N, "text": "..."}`.

## Language Support

Currently installed languages (check with the `!` command below):

!python -c "import pytesseract, os; pytesseract.pytesseract.tesseract_cmd = r'C:\Program Files\Tesseract-OCR\tesseract.exe'; os.environ['TESSDATA_PREFIX'] = os.path.expanduser('~/tesseract/tessdata'); print(pytesseract.get_languages())"

Use `--lang` to specify (default: `eng+chi_sim` for English + Simplified Chinese).

## Dependencies

- Tesseract 5.4.0 (installed at `C:\Program Files\Tesseract-OCR\`)
- Python: `pytesseract`, `Pillow`, `pdf2image`
- Language packs in `~/tesseract/tessdata/`

## Limitations

- OCR is text-only — it does NOT understand visual layout, colors, or charts
- Handwriting accuracy is significantly lower than printed text
- For complex layouts (tables, multi-column), use `--json` and post-process
- The extracted text is plain; semantic analysis is done by the LLM afterward
