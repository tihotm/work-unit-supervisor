import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = process.cwd();
const skipSegments = ['node_modules', 'dist', '.git'];
const files = await readdir(root, { recursive: true });
const sources = files.filter((file) => {
  if (!(file.endsWith('.ts') || file.endsWith('.tsx') || file.endsWith('.js') || file.endsWith('.mjs'))) return false;
  return !skipSegments.some((segment) => file.includes(segment));
});
for (const file of sources) {
  const text = await readFile(resolve(root, file), 'utf8');
  if (text.includes('\t')) {
    throw new Error(`tab character found in ${file}`);
  }
  if (/\n$/.test(text) === false) {
    throw new Error(`missing trailing newline in ${file}`);
  }
}
