import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = process.cwd();
const skipSegments = ['node_modules', 'dist', '.git', 'docs', 'README.md', '.gitignore', 'package-lock.json', 'scripts'];
const files = await readdir(root, { recursive: true });
const sources = files.filter((file) => {
  if (!(file.endsWith('.ts') || file.endsWith('.tsx') || file.endsWith('.js') || file.endsWith('.mjs') || file.endsWith('.json'))) return false;
  return !skipSegments.some((segment) => file.includes(segment));
});
for (const file of sources) {
  const text = await readFile(resolve(root, file), 'utf8');
  for (const token of ['bomprati', 'catalogo', 'catalog', 'manufacturer', 'vehicle', 'enrichment']) {
    if (text.toLowerCase().includes(token)) {
      throw new Error(`blocked import boundary token found in ${file}: ${token}`);
    }
  }
}
