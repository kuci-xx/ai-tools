import express from "express";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import pdfParse from "pdf-parse";
import { PDFDocument } from "pdf-lib";
import lunr from "lunr";
import bodyParser from "body-parser";
import fsExtra from "fs-extra";
import multer from "multer";
import EPub from "epub-gen"; // note: package name is epub-gen

dotenv.config();

const PDF_DIR = process.env.PDF_DIR || path.join(process.env.HOME || ".", "Documents", "PDF-Bibliothek");
const PORT = parseInt(process.env.PORT || "3333", 10);

// Create PDF_DIR if it doesn't exist (helpful for first run)
fsExtra.ensureDirSync(PDF_DIR);

const app = express();
app.use(bodyParser.json({ limit: "10mb" }));
app.use(bodyParser.urlencoded({ extended: true }));

// Simple file upload middleware (for adding PDFs)
const upload = multer({ dest: path.join("/tmp", "mcp-pdf-upload") });

// -----------------------
// Utility helpers
// -----------------------
function resolvePdfPath(filename) {
  // Accept either absolute path or filename relative to PDF_DIR
  if (path.isAbsolute(filename)) return filename;
  return path.join(PDF_DIR, filename);
}

async function listPDFFiles() {
  const entries = await fs.promises.readdir(PDF_DIR, { withFileTypes: true });
  return entries
    .filter(e => e.isFile() && e.name.toLowerCase().endsWith(".pdf"))
    .map(e => ({ name: e.name, path: path.join(PDF_DIR, e.name) }));
}

async function extractPDFText(filePath, { startPage = 1, endPage = null } = {}) {
  const data = await fs.promises.readFile(filePath);
  const parsed = await pdfParse(data, {});
  // pdf-parse returns full text; for page ranges you'd need more advanced parsing.
  // For now, return full text. For page ranges consider using pdf-lib to split pages.
  return parsed.text;
}

async function getPDFMetadata(filePath) {
  const buffer = await fs.promises.readFile(filePath);
  const parsed = await pdfParse(buffer);
  // parsed.info typically contains metadata
  return {
    info: parsed.info || {},
    numpages: parsed.numpages || null,
    textSample: (parsed.text || "").slice(0, 500),
  };
}

function simpleSummarizeText(text, sentenceCount = 4) {
  // Very naive sentence splitter based on dot punctuation.
  const sentences = text
    .replace(/\n+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .filter(Boolean);
  if (sentences.length <= sentenceCount) return sentences.join(" ");
  return sentences.slice(0, sentenceCount).join(" ");
}

// -----------------------
// Lunr index for full-text search (built at startup)
// -----------------------
let lunrIndex = null;
let docStore = {};

async function buildIndex() {
  const files = await listPDFFiles();
  const docs = [];
  docStore = {};

  for (const f of files) {
    try {
      const text = await extractPDFText(f.path);
      const id = f.name; // use filename as id
      const truncated = text.slice(0, 20000); // don't index massive texts fully
      docs.push({ id, title: f.name, body: truncated });
      docStore[id] = { path: f.path, title: f.name, text: truncated };
    } catch (e) {
      console.warn(`Failed to extract text for indexing: ${f.name}`, e.message);
    }
  }

  lunrIndex = lunr(function () {
    this.ref('id');
    this.field('title');
    this.field('body');
    for (const d of docs) this.add(d);
  });

  console.log("Index built with", Object.keys(docStore).length, "documents");
}

// Build index at startup
buildIndex().catch(err => console.error("Index build failed:", err));

// -----------------------
// Tool endpoints (MCP-style)
// Each endpoint responds JSON: { ok: true, result: ... } on success or { ok: false, error: ... }
// -----------------------

app.get('/tool/list_pdfs', async (req, res) => {
  try {
    const files = await listPDFFiles();
    res.json({ ok: true, result: files.map(f => ({ name: f.name })) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/tool/get_pdf_metadata', async (req, res) => {
  try {
    const { file } = req.query;
    if (!file) return res.status(400).json({ ok: false, error: 'missing "file" query param' });
    const p = resolvePdfPath(file);
    const meta = await getPDFMetadata(p);
    res.json({ ok: true, result: meta });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/tool/extract_pdf_text', async (req, res) => {
  try {
    const { file } = req.query;
    if (!file) return res.status(400).json({ ok: false, error: 'missing "file" query param' });
    const p = resolvePdfPath(file);
    const text = await extractPDFText(p);
    res.json({ ok: true, result: { text } });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/tool/search_in_pdfs', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.status(400).json({ ok: false, error: 'missing "q" query param' });
    if (!lunrIndex) return res.status(500).json({ ok: false, error: 'index not ready' });
    const results = lunrIndex.search(q);
    const mapped = results.map(r => ({ id: r.ref, score: r.score, title: docStore[r.ref].title }));
    res.json({ ok: true, result: mapped });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/tool/summarize_pdf', async (req, res) => {
  try {
    const { file, sentences } = req.query;
    if (!file) return res.status(400).json({ ok: false, error: 'missing "file" query param' });
    const scount = parseInt(sentences || "4", 10);
    const p = resolvePdfPath(file);
    const text = await extractPDFText(p);
    const summary = simpleSummarizeText(text, scount);
    res.json({ ok: true, result: { summary } });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/tool/split_pdf', upload.none(), async (req, res) => {
  // Request body: { file: "name.pdf", startPage: 1, endPage: 3 }
  try {
    const { file } = req.body;
    let { startPage, endPage } = req.body;
    if (!file) return res.status(400).json({ ok: false, error: 'missing "file" body param' });
    startPage = parseInt(startPage || "1", 10);
    endPage = endPage ? parseInt(endPage, 10) : null;

    const p = resolvePdfPath(file);
    const existing = await fs.promises.readFile(p);
    const srcDoc = await PDFDocument.load(existing);
    const total = srcDoc.getPageCount();
    const s = Math.max(1, startPage);
    const e = endPage ? Math.min(endPage, total) : total;
    const newDoc = await PDFDocument.create();

    for (let i = s - 1; i <= e - 1; i++) {
      const [copied] = await newDoc.copyPages(srcDoc, [i]);
      newDoc.addPage(copied);
    }

    const outBytes = await newDoc.save();
    const outName = `${path.basename(file, '.pdf')}_pages_${s}-${e}.pdf`;
    const outPath = path.join(PDF_DIR, outName);
    await fs.promises.writeFile(outPath, outBytes);

    // Rebuild index to include new file (optional)
    buildIndex().catch(() => {});

    res.json({ ok: true, result: { outName, outPath } });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/tool/upload_pdf', upload.single('file'), async (req, res) => {
  try {
    // uploaded file in req.file.path
    if (!req.file) return res.status(400).json({ ok: false, error: 'no file uploaded' });
    const dest = path.join(PDF_DIR, req.file.originalname);
    await fsExtra.move(req.file.path, dest, { overwrite: true });
    buildIndex().catch(() => {});
    res.json({ ok: true, result: { filename: req.file.originalname } });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/tool/convert_pdf_to_epub', upload.none(), async (req, res) => {
  try {
    // Basic EPUB conversion: extract text and write a simple single-chapter EPUB.
    const { file, title } = req.body;
    if (!file) return res.status(400).json({ ok: false, error: 'missing "file" body param' });
    const p = resolvePdfPath(file);
    const text = await extractPDFText(p);

    const outName = `${path.basename(file, '.pdf')}.epub`;
    const outPath = path.join(PDF_DIR, outName);

    const option = {
      title: title || path.basename(file, '.pdf'),
      author: 'Converted',
      content: [
        {
          title: title || 'Chapter 1',
          data: text || ' ',
        },
      ],
    };

    // EPub expects a path string to write to
    await new EPub(option, outPath).promise;

    // Note: epub-gen's API is callback/promise-like; the above is a simple wiring.
    res.json({ ok: true, result: { outPath } });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Health endpoint
app.get('/health', (req, res) => {
  res.json({ ok: true, result: { status: 'running', pdf_dir: PDF_DIR } });
});

// Simple homepage
app.get('/', (req, res) => {
  res.type('text/plain').send(
    `MCP PDF Server running. Tools available:\n` +
      `- GET /tool/list_pdfs\n` +
      `- GET /tool/get_pdf_metadata?file=filename.pdf\n` +
      `- GET /tool/extract_pdf_text?file=filename.pdf\n` +
      `- GET /tool/search_in_pdfs?q=term\n` +
      `- GET /tool/summarize_pdf?file=filename.pdf&sentences=4\n` +
      `- POST /tool/split_pdf  (body: file, startPage, endPage)\n` +
      `- POST /tool/upload_pdf (multipart form, field name: file)\n` +
      `- POST /tool/convert_pdf_to_epub (body: file)\n` +
      `Health: GET /health\n`
  );
});

// Start server
app.listen(PORT, () => {
  console.log(`MCP PDF Server listening on http://localhost:${PORT}`);
  console.log(`PDF directory: ${PDF_DIR}`);
});
