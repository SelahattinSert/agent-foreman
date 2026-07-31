import {readFile} from 'node:fs/promises';
import path from 'node:path';

import {ProjectSummarySchema, type ProjectSummary} from '@agent-foreman/contracts';
import {discoverGitRepository, requireGit} from '@agent-foreman/workspace';

const extensionLanguages: Readonly<Record<string, string>> = {
  '.c': 'C',
  '.cc': 'C++',
  '.cpp': 'C++',
  '.cs': 'C#',
  '.css': 'CSS',
  '.go': 'Go',
  '.html': 'HTML',
  '.java': 'Java',
  '.js': 'JavaScript',
  '.jsx': 'JavaScript',
  '.kt': 'Kotlin',
  '.php': 'PHP',
  '.py': 'Python',
  '.rb': 'Ruby',
  '.rs': 'Rust',
  '.swift': 'Swift',
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript',
  '.vue': 'Vue',
};

const packageManagerFiles: Readonly<Record<string, string>> = {
  'bun.lock': 'bun',
  'bun.lockb': 'bun',
  'package-lock.json': 'npm',
  'pnpm-lock.yaml': 'pnpm',
  'yarn.lock': 'yarn',
  'Cargo.lock': 'cargo',
  'go.sum': 'go',
  'poetry.lock': 'poetry',
  'uv.lock': 'uv',
};

const relevantPattern =
  /(?:^|\/)(?:AGENTS\.md|README(?:\.[^/]*)?|package\.json|pnpm-workspace\.yaml|tsconfig(?:\.[^/]*)?\.json|pyproject\.toml|Cargo\.toml|go\.mod|Makefile)$/iu;

export const summarizeRepository = async (projectRoot: string): Promise<ProjectSummary> => {
  const discovery = await discoverGitRepository(projectRoot);
  if (discovery.kind !== 'git') {
    return ProjectSummarySchema.parse({
      root: path.resolve(projectRoot),
      vcs: 'none',
      languages: [],
      packageManagers: [],
      relevantFiles: [],
      summary: 'The project is not a Git repository.',
    });
  }
  const files = (await requireGit(discovery.projectRoot, ['ls-files', '-z']))
    .split('\0')
    .filter(Boolean);
  const languages = new Set<string>();
  const packageManagers = new Set<string>();
  for (const file of files) {
    const language = extensionLanguages[path.extname(file).toLowerCase()];
    if (language !== undefined) languages.add(language);
    const manager = packageManagerFiles[path.basename(file)];
    if (manager !== undefined) packageManagers.add(manager);
  }
  const relevantFiles = files.filter((file) => relevantPattern.test(file)).slice(0, 80);
  let packageDescription: string | undefined;
  try {
    const parsed = JSON.parse(
      await readFile(path.join(discovery.projectRoot, 'package.json'), 'utf8'),
    ) as unknown;
    if (typeof parsed === 'object' && parsed !== null && 'description' in parsed) {
      const description = (parsed as {description?: unknown}).description;
      if (typeof description === 'string' && description.trim() !== '') {
        packageDescription = description.trim();
      }
    }
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const cleanliness = discovery.clean
    ? 'clean'
    : `dirty (${String(discovery.trackedChanges.length)} tracked, ${String(discovery.untrackedFiles.length)} untracked)`;
  return ProjectSummarySchema.parse({
    root: discovery.projectRoot,
    vcs: 'git',
    languages: [...languages].sort(),
    packageManagers: [...packageManagers].sort(),
    relevantFiles,
    summary: [
      packageDescription,
      `Git repository on ${discovery.branch ?? 'detached HEAD'}; ${cleanliness}; ${String(files.length)} tracked files.`,
    ]
      .filter((value): value is string => value !== undefined)
      .join(' '),
  });
};
