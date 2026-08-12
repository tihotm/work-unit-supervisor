import { readdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

const root = process.cwd();
const skipSegments = ['node_modules', 'dist', '.git', 'docs', 'tests', 'README.md', '.gitignore', 'package-lock.json', 'scripts'];
const forbiddenTokens = ['bomprati', 'catalogo', 'catalog', 'manufacturer', 'vehicle', 'enrichment'];
const coreDir = resolve(root, "src", "core");
const portsDir = resolve(root, "src", "ports");
const diffAuditorDir = resolve(root, "src", "diff-auditor");
const workflowDir = resolve(root, "src", "workflow");
const infrastructureDir = resolve(root, "src", "infrastructure");
const gitInfrastructureDir = resolve(root, "src", "infrastructure", "git");
const workspaceInfrastructureDir = resolve(root, "src", "infrastructure", "workspace");
const executorsDir = resolve(root, "src", "executors");
const files = await readdir(root, { recursive: true });
const sources = files.filter((file) => {
  if (!(file.endsWith('.ts') || file.endsWith('.tsx') || file.endsWith('.js') || file.endsWith('.mjs') || file.endsWith('.json'))) return false;
  return !skipSegments.some((segment) => file.includes(segment));
});

function collectStaticImportSpecifiers(text) {
  const specifiers = [];
  const importExportPattern = /\b(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/g;
  for (const match of text.matchAll(importExportPattern)) {
    specifiers.push(match[1]);
  }
  return specifiers;
}

function isInside(candidate, parent) {
  const rel = relative(parent, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

for (const file of sources) {
  const filePath = resolve(root, file);
  const normalizedFile = relative(root, filePath).replaceAll("\\", "/");
  const text = await readFile(filePath, 'utf8');
  for (const token of forbiddenTokens) {
    if (text.toLowerCase().includes(token)) {
      throw new Error(`blocked import boundary token found in ${file}: ${token}`);
    }
  }

  const specifiers = collectStaticImportSpecifiers(text);
  const sourceDir = dirname(filePath);
  if (normalizedFile.startsWith('src/core/')) {
    for (const specifier of specifiers) {
      if (!specifier.startsWith(".") && !specifier.startsWith("/")) {
        continue;
      }
      const target = resolve(sourceDir, specifier);
      if (isInside(target, portsDir) || isInside(target, diffAuditorDir) || isInside(target, infrastructureDir) || isInside(target, executorsDir)) {
        throw new Error(`core must not import ports, diff auditor, executors, or infrastructure: ${normalizedFile} -> ${specifier}`);
      }
    }
  }

  if (normalizedFile.startsWith('src/executors/openhands/')) {
    for (const specifier of specifiers) {
      if (!specifier.startsWith(".") && !specifier.startsWith("/")) {
        continue;
      }
      const target = resolve(sourceDir, specifier);
      const allowed =
        isInside(target, coreDir) ||
        isInside(target, portsDir) ||
        isInside(target, diffAuditorDir) ||
        isInside(target, workspaceInfrastructureDir) ||
        isInside(target, executorsDir);
      if (!allowed) {
        throw new Error(`openhands executors must only import core, ports, diff auditor, workspace infrastructure, or local modules: ${normalizedFile} -> ${specifier}`);
      }
    }
    continue;
  }

  if (normalizedFile.startsWith('src/ports/')) {
    for (const specifier of specifiers) {
      if (!specifier.startsWith(".") && !specifier.startsWith("/")) {
        continue;
      }
      const target = resolve(sourceDir, specifier);
      const allowed = isInside(target, coreDir) || isInside(target, portsDir);
      if (!allowed) {
        throw new Error(`ports must only import core or local modules: ${normalizedFile} -> ${specifier}`);
      }
    }
  }

  if (normalizedFile.startsWith('src/diff-auditor/')) {
    for (const specifier of specifiers) {
      if (!specifier.startsWith(".") && !specifier.startsWith("/")) {
        continue;
      }
      const target = resolve(sourceDir, specifier);
      const allowed = isInside(target, coreDir) || isInside(target, diffAuditorDir);
      if (!allowed) {
        throw new Error(`diff auditor must only import core or local modules: ${normalizedFile} -> ${specifier}`);
      }
    }
  }

  if (normalizedFile.startsWith('src/workflow/')) {
    for (const specifier of specifiers) {
      if (!specifier.startsWith(".") && !specifier.startsWith("/")) {
        continue;
      }
      const target = resolve(sourceDir, specifier);
      const allowed =
        isInside(target, coreDir) ||
        isInside(target, portsDir) ||
        isInside(target, diffAuditorDir) ||
        isInside(target, infrastructureDir) ||
        isInside(target, executorsDir) ||
        isInside(target, workflowDir);
      if (!allowed) {
        throw new Error(`workflow must only import core, ports, diff auditor, infrastructure, executors, or local workflow modules: ${normalizedFile} -> ${specifier}`);
      }
    }
  }

  if (normalizedFile.startsWith('src/executors/')) {
    for (const specifier of specifiers) {
      if (!specifier.startsWith(".") && !specifier.startsWith("/")) {
        continue;
      }
      const target = resolve(sourceDir, specifier);
      const allowed = isInside(target, coreDir) || isInside(target, executorsDir);
      if (!allowed) {
        throw new Error(`executors must only import core or local modules: ${normalizedFile} -> ${specifier}`);
      }
    }
  }

  if (normalizedFile.startsWith('src/infrastructure/')) {
    if (normalizedFile.startsWith('src/infrastructure/git/')) {
      for (const specifier of specifiers) {
        if (!specifier.startsWith(".") && !specifier.startsWith("/")) {
          continue;
        }
        const target = resolve(sourceDir, specifier);
        const allowed = isInside(target, workspaceInfrastructureDir) || isInside(target, gitInfrastructureDir);
        if (!allowed) {
          throw new Error(`git infrastructure must only import workspace infrastructure or local git modules: ${normalizedFile} -> ${specifier}`);
        }
      }
      continue;
    }

    for (const specifier of specifiers) {
      if (!specifier.startsWith(".") && !specifier.startsWith("/")) {
        continue;
      }
      const target = resolve(sourceDir, specifier);
      const allowed = isInside(target, infrastructureDir);
      if (!allowed) {
        throw new Error(`infrastructure must only import local infrastructure modules: ${normalizedFile} -> ${specifier}`);
      }
    }
  }
}
