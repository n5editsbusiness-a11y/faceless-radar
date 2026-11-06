import fs from 'node:fs';
import path from 'node:path';

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw new Error(`Cannot read ${file}: ${err.message}`);
  }
}

function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

export function writeJson(file, data) {
  atomicWrite(file, `${JSON.stringify(data, null, 2)}\n`);
}

// One record per line: keeps git diffs small and readable for big arrays.
export function writeJsonRows(file, rows) {
  const body = rows.map((r) => `  ${JSON.stringify(r)}`).join(',\n');
  atomicWrite(file, `[\n${body}\n]\n`);
}
