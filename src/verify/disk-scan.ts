/**
 * Disk side of the verify pass: which ψ/ files exist, and which are still
 * outside the index.
 *
 * Kept apart from the handler so the classification rules stay readable.
 */
import path from 'path';
import { discoverCrewPsiDirs, discoverProjectPsiDirs } from '../indexer/discovery.ts';
import { walkMarkdownFiles } from './files.ts';

const MEMORY_SUBDIRS = ['resonance', 'learnings', 'retrospectives'];

export interface DiskScan {
  /** relativePath -> mtimeMs */
  diskFiles: Map<string, number>;
  /** relativePaths under an inbox root, not yet in the DB index */
  untrackedPathSet: Set<string>;
}

export function scanDisk(repoRoot: string, tenantId: string | null | undefined): DiskScan {
  const diskFiles = new Map<string, number>();

  const walkInto = (fullDir: string) => {
    for (const f of walkMarkdownFiles(fullDir, repoRoot)) {
      diskFiles.set(f.relativePath, f.mtimeMs);
    }
  };

  const projectPsiDirs = discoverProjectPsiDirs(repoRoot);
  const crewPsiDirs = discoverCrewPsiDirs(repoRoot);
  const psiDirs = [...projectPsiDirs, ...crewPsiDirs];
  for (const psiDir of psiDirs) {
    for (const sub of MEMORY_SUBDIRS) {
      walkInto(path.join(psiDir, 'memory', sub));
    }
    walkInto(path.join(psiDir, 'learn'));
  }

  for (const sub of MEMORY_SUBDIRS) {
    walkInto(path.join(repoRoot, 'ψ', 'memory', sub));
  }
  walkInto(path.join(repoRoot, 'ψ', 'learn'));

  // ψ/inbox is an indexed source, not merely an untracked side tree.
  walkInto(path.join(repoRoot, 'ψ', 'inbox'));
  for (const psiDir of projectPsiDirs) {
    walkInto(path.join(psiDir, 'inbox'));
  }

  const untrackedRoots = [path.join(repoRoot, 'ψ', 'inbox')];
  for (const psiDir of psiDirs) {
    untrackedRoots.push(path.join(psiDir, 'inbox'));
  }
  const untrackedPathSet = new Set<string>();
  if (!tenantId) {
    for (const fullDir of untrackedRoots) {
      for (const file of walkMarkdownFiles(fullDir, repoRoot)) {
        untrackedPathSet.add(file.relativePath);
      }
    }
  }

  return { diskFiles, untrackedPathSet };
}
