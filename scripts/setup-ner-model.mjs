// Build/setup only. Runtime classifiers never import this network capability.
import { createHash, randomUUID } from 'node:crypto';
import { readFile, mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('src/lib/pii-screener/ner-manifest.json', root), 'utf8'));
const target = new URL('assets/pii-ner/', root);
await mkdir(target, { recursive: true });
const valid = (bytes, expected) => bytes.length === expected.bytes && createHash('sha256').update(bytes).digest('hex') === expected.sha256;
for (const [name, expected] of Object.entries(manifest.files)) {
  const destination = new URL(name, target);
  try { if (valid(await readFile(destination), expected)) continue; } catch { /* explicit setup may repair missing assets */ }
  const response = await fetch(`https://huggingface.co/${manifest.id}/resolve/${manifest.revision}/${name}`, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error('ner_asset_download_failed');
  const chunks = []; let count = 0;
  for await (const chunk of response.body) {
    count += chunk.length;
    if (count > expected.bytes) { await response.body.cancel().catch(() => {}); throw new Error('ner_asset_size_invalid'); }
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  if (!valid(bytes, expected)) throw new Error('ner_asset_integrity_invalid');
  const temporary = fileURLToPath(destination) + '.' + randomUUID() + '.tmp';
  try { await writeFile(temporary, bytes, { flag: 'wx', mode: 0o444 }); await rename(temporary, destination); }
  finally { await unlink(temporary).catch(() => {}); }
}
console.log('NER assets verified at pinned revision ' + manifest.revision);
