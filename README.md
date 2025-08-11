# MCP for local books in PDF format

MCP PDF Server (single-file JavaScript implementation)

What this file provides:
- A small Express-based HTTP server exposing MCP-like "tools" for interacting with PDF books
  in a directory on your MacBook.
- Tools implemented:
  - list_pdfs
  - get_pdf_metadata
  - extract_pdf_text
  - search_in_pdfs
  - summarize_pdf
  - split_pdf (simple page-extract)
  - convert_pdf_to_epub (placeholder / basic wiring)

Requirements (install globally in your project folder):
  npm init -y
  npm install express dotenv pdf-parse pdf-lib lunr fs-extra body-parser multer epub-gen

Notes:
- This is a self-contained starting point. You can register these endpoints as "tools"
  in your MCP environment (whichever MCP host you use) by pointing tool-calls to the
  respective HTTP endpoints (e.g. POST /tool/list_pdfs).
- The summarizer is simple (extractive, sentence-based). Replace with an LLM call
  for higher-quality summaries.
- convert_pdf_to_epub uses epub-gen to write a very basic EPUB. For production-grade
  conversions, consider using Calibre command-line tools.

Configuration (create a .env file in the same folder):
  PDF_DIR=/Users/yourname/Documents/PDF-Bibliothek
  PORT=3333

Run:
  node mcp-pdf-server.js
