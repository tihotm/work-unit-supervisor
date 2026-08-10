import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = process.cwd();
const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')) as { name?: string };
if (packageJson.name !== 'work-unit-supervisor') {
  throw new Error('package name mismatch');
}
