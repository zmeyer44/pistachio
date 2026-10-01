/**
 * pdf.js's worker, as a module worker of the shell's own (PdfViewer): a
 * relative `new URL(…, import.meta.url)` both Vite (the desktop renderer)
 * and webpack (the web app) bundle. Loaded in a worker, pdf.js's worker
 * build listens on the worker's own port. (JavaScript: the worker build has
 * no types, and needs none — it is loaded only for its effect.)
 */
import "pdfjs-dist/build/pdf.worker.min.mjs";
