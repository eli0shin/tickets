import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LintCode } from '../../src/tracker/index.ts';

export type LintCase = {
  readonly project: string;
  readonly codes: readonly LintCode[];
};

const validProject = (gitRepo = '') =>
  `---\nDefault-Status: todo\nGit-Repo: ${gitRepo}\n---\n`;
const validTicket =
  '---\nAssigned-To:\nTags: []\nParent:\nBlocked-By: []\n---\n';

export async function createLintWorkspace(
  workspaceRoot: string
): Promise<readonly LintCase[]> {
  await mkdir(workspaceRoot, { recursive: true });

  await project(workspaceRoot, 'external', validProject());
  await ticket(workspaceRoot, 'external', 'todo', '001-shared', validTicket);

  await project(
    workspaceRoot,
    'clean-project',
    validProject('https://example.com/clean/repo.git')
  );
  await ticket(
    workspaceRoot,
    'clean-project',
    'todo',
    '001-clean',
    '---\nAssigned-To:\nTags: [one]\nParent: external/001-shared\nBlocked-By: [001-clean, 001-clean]\n---\n'
  );
  await writeFile(join(workspaceRoot, 'clean-project', '.ignored'), 'hidden');

  await mkdir(join(workspaceRoot, 'missing-metadata', 'todo'), {
    recursive: true,
  });

  await project(workspaceRoot, 'malformed-project', 'Default-Status: todo\n');
  await project(
    workspaceRoot,
    'duplicate-project',
    '---\nDefault-Status: todo\nDefault-Status: done\n---\n'
  );
  await project(workspaceRoot, 'missing-default', '---\nGit-Repo:\n---\n');
  await project(
    workspaceRoot,
    'invalid-default',
    '---\nDefault-Status: Not_Normalized\n---\n'
  );

  const missingDirectory = join(workspaceRoot, 'missing-directory');
  await mkdir(missingDirectory, { recursive: true });
  await writeFile(
    join(missingDirectory, 'project.md'),
    '---\nDefault-Status: backlog\n---\n'
  );

  await project(
    workspaceRoot,
    'invalid-repository',
    validProject('not-a-remote')
  );

  await project(workspaceRoot, 'ticket-errors', validProject());
  await writeFile(
    join(workspaceRoot, 'ticket-errors', 'unexpected.txt'),
    'unexpected'
  );
  await writeFile(
    join(workspaceRoot, 'ticket-errors', 'todo', 'unexpected.txt'),
    'unexpected'
  );
  await ticket(
    workspaceRoot,
    'ticket-errors',
    'todo',
    '001-invalid-fields',
    '---\nAssigned-To: Not_Normalized\nTags: [valid, Invalid]\nParent: invalid/reference/path\nBlocked-By: not-an-array\n---\n'
  );
  await ticket(
    workspaceRoot,
    'ticket-errors',
    'todo',
    '002-broken-references',
    '---\nParent: 999-missing\nBlocked-By: [external/999-missing]\n---\n'
  );
  await ticket(
    workspaceRoot,
    'ticket-errors',
    'todo',
    '003-malformed',
    '---\nTags: [unterminated\n---\n'
  );
  await ticket(
    workspaceRoot,
    'ticket-errors',
    'todo',
    '004-duplicate-key',
    '---\nTags: []\nTags: []\n---\n'
  );
  await ticket(
    workspaceRoot,
    'ticket-errors',
    'todo',
    '006-first-id',
    validTicket
  );
  await ticket(
    workspaceRoot,
    'ticket-errors',
    'todo',
    '006-second-id',
    validTicket
  );

  await project(
    workspaceRoot,
    'duplicate-repository',
    validProject('git@example.com:Owner/Repo.git')
  );
  await project(
    workspaceRoot,
    'duplicate-repository-peer',
    validProject('ssh://git@example.com:22/owner/repo')
  );

  return [
    { project: 'clean-project', codes: [] },
    { project: 'missing-metadata', codes: ['missing-project-metadata'] },
    { project: 'malformed-project', codes: ['malformed-project-yaml'] },
    { project: 'duplicate-project', codes: ['duplicate-project-key'] },
    { project: 'missing-default', codes: ['missing-default-status'] },
    { project: 'invalid-default', codes: ['invalid-default-status'] },
    {
      project: 'missing-directory',
      codes: ['missing-default-status-directory'],
    },
    { project: 'invalid-repository', codes: ['invalid-git-repo'] },
    {
      project: 'ticket-errors',
      codes: [
        'unexpected-project-entry',
        'unexpected-status-entry',
        'invalid-assigned-to',
        'invalid-tags',
        'invalid-parent',
        'invalid-blocked-by',
        'broken-parent-reference',
        'broken-blocker-reference',
        'malformed-ticket-yaml',
        'duplicate-ticket-key',
        'duplicate-ticket-id',
        'duplicate-ticket-id',
      ],
    },
    { project: 'duplicate-repository', codes: ['duplicate-git-repo'] },
  ];
}

async function project(
  workspaceRoot: string,
  name: string,
  metadata: string
): Promise<void> {
  const path = join(workspaceRoot, name);
  await mkdir(join(path, 'todo'), { recursive: true });
  await writeFile(join(path, 'project.md'), metadata);
}

async function ticket(
  workspaceRoot: string,
  projectName: string,
  statusName: string,
  name: string,
  source: string
): Promise<void> {
  const statusPath = join(workspaceRoot, projectName, statusName);
  await mkdir(statusPath, { recursive: true });
  await writeFile(join(statusPath, `${name}.md`), source);
}
