// Copies pdf.js CMaps, standard fonts and wasm decoders into public/pdfjs so they are
// served from our own origin (keeps the Content-Security-Policy tight).
import { cpSync, mkdirSync, rmSync, existsSync } from 'node:fs';

const src = 'node_modules/pdfjs-dist';
const out = 'public/pdfjs';
if (!existsSync(src)) {
  console.error('pdfjs-dist is not installed. Run npm install first.');
  process.exit(1);
}
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const dir of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) cpSync(`${src}/${dir}`, `${out}/${dir}`, { recursive: true });
console.log('pdf.js assets copied to', out);
