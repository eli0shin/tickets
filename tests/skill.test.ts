import { afterEach, describe, expect, mock, test } from 'bun:test';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { installSkill } from '../src/skill.ts';

const assetDirectory = join(import.meta.dir, '../assets/tickets');
const assetPath = join(assetDirectory, 'SKILL.md');
const temporaryDirectories: string[] = [];

const expectedFrontMatter = `name: tickets
description: Manage work in the local Tickets filesystem tracker. Use when the user asks to inspect, search, create, claim, update, move, rename, complete, or lint a Tickets project or ticket.`;

const expectedWorkflow = `# Tickets

Use the Tickets CLI and its local filesystem workspace to manage ticket work predictably.

## Resolve and inspect

Use the Tickets CLI to discover the selected project, then use \`tickets list\`, \`tickets search\`, and \`tickets show\` to inspect the relevant work. The first line from \`tickets show\` is the resolved ticket's absolute path, followed by its complete document. Consult \`tickets --help\` or command-specific help when you need command syntax. Do not proceed until you know the exact project and tickets you will operate on.

## Mutate through the narrowest interface

Use CLI commands for creation, rename, movement, completion, query, and lint. Edit Markdown directly for ticket bodies, assignment, tags, parent, and blockers. Never reimplement an existing CLI operation with ad hoc shell commands or YAML manipulation.

After directly editing standard metadata, run \`tickets lint\`; the edit is complete only when lint passes. Body-only edits do not require lint.

## Claim before executing ticket work

Read the ticket and confirm \`Assigned-To\` is empty before claiming it. Never overwrite another assignee. Use the human or agent name supplied by the user, project, or harness and preserve it exactly. If none is supplied, choose one recognizable name and reuse it throughout that session. Write it directly to \`Assigned-To\`, then run \`tickets lint\`.

Move the ticket to another status only when the user or project conventions identify the work status.

## Complete explicitly

When the ticket's requested work is complete, use \`tickets done\`. Completion is reached only when the command succeeds and its cleanup finishes.
`;

async function readSkillSource(): Promise<{
  frontMatter: unknown;
  rawFrontMatter: string;
  workflow: string;
  source: string;
}> {
  const source = (await readFile(assetPath, 'utf8')).replaceAll('\r\n', '\n');
  const match =
    /^---\n(?<frontMatter>[\s\S]*?)\n---\n\n(?<workflow>[\s\S]+)$/.exec(source);

  if (match?.groups === undefined) {
    throw new Error('SKILL.md must contain YAML front matter and a body');
  }

  return {
    frontMatter: parse(match.groups.frontMatter),
    rawFrontMatter: match.groups.frontMatter,
    workflow: match.groups.workflow,
    source,
  };
}

async function temporaryTarget(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'tickets-skill-'));
  temporaryDirectories.push(directory);
  return join(directory, 'nested', 'tickets');
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true }))
  );
});

describe('bundled skill source contract', () => {
  test('has the exact contracted front matter and operating workflow', async () => {
    const { frontMatter, rawFrontMatter, workflow } = await readSkillSource();

    expect(rawFrontMatter).toBe(expectedFrontMatter);
    expect(frontMatter).toEqual({
      name: 'tickets',
      description:
        'Manage work in the local Tickets filesystem tracker. Use when the user asks to inspect, search, create, claim, update, move, rename, complete, or lint a Tickets project or ticket.',
    });
    expect(workflow).toBe(expectedWorkflow);
  });

  test('is harness-neutral and gives no forbidden integration or claim guidance', async () => {
    const { source } = await readSkillSource();

    expect(source).not.toMatch(/\b(?:pi|claude|codex|wayfinder)\b/i);
    expect(source).not.toMatch(
      /\b(?:wrappers?|extensions?|variants?|environment[-_ ]variables?)\b/i
    );
    expect(source).not.toMatch(/\bunassign(?:ed|ing|ment)?\b/i);
    expect(source).not.toMatch(
      /\b(?:(?:release|relinquish|drop)[-_ ](?:a[-_ ]|the[-_ ]|your[-_ ])?claim|claim[-_ ]release)\b/i
    );
  });

  test("is the bundle's only file", async () => {
    expect(await readdir(assetDirectory)).toEqual(['SKILL.md']);
  });
});

describe('skill installation', () => {
  test('creates an exact target and installs the bundled source bytes', async () => {
    const target = await temporaryTarget();

    expect(await installSkill({ target })).toEqual({
      status: 'installed',
      path: resolve(target, 'SKILL.md'),
    });
    expect(await readFile(join(target, 'SKILL.md'))).toEqual(
      await readFile(assetPath)
    );
  });

  test('asks for confirmation before replacing an existing skill', async () => {
    const target = await temporaryTarget();
    const installedPath = join(target, 'SKILL.md');
    await mkdir(target, { recursive: true });
    await writeFile(installedPath, 'old skill');
    const confirmOverwrite = mock(async () => true);

    expect(
      await installSkill({
        target,
        interactive: true,
        confirmOverwrite,
      })
    ).toEqual({ status: 'installed', path: installedPath });
    expect(confirmOverwrite).toHaveBeenCalledTimes(1);
    expect(confirmOverwrite).toHaveBeenCalledWith(installedPath);
    expect(await readFile(installedPath)).toEqual(await readFile(assetPath));
  });

  test('declining preserves the existing skill and succeeds without a write', async () => {
    const target = await temporaryTarget();
    const installedPath = join(target, 'SKILL.md');
    await mkdir(target, { recursive: true });
    await writeFile(installedPath, 'keep me');

    expect(
      await installSkill({
        target,
        interactive: true,
        confirmOverwrite: async () => false,
      })
    ).toEqual({ status: 'declined' });
    expect(await readFile(installedPath, 'utf8')).toBe('keep me');
  });

  test('lets rejected confirmation escape as an unexpected failure', async () => {
    const target = await temporaryTarget();
    const installedPath = join(target, 'SKILL.md');
    await mkdir(target, { recursive: true });
    await writeFile(installedPath, 'keep me');

    await expect(
      installSkill({
        target,
        interactive: true,
        confirmOverwrite: async () => {
          throw new Error('confirmation unavailable');
        },
      })
    ).rejects.toThrow('confirmation unavailable');
    expect(await readFile(installedPath, 'utf8')).toBe('keep me');
  });

  test('fails non-interactively when the skill already exists', async () => {
    const target = await temporaryTarget();
    const installedPath = join(target, 'SKILL.md');
    await mkdir(target, { recursive: true });
    await writeFile(installedPath, 'keep me');

    expect(await installSkill({ target, interactive: false })).toEqual({
      status: 'error',
      message: `${installedPath} already exists; use --force to overwrite it`,
    });
    expect(await readFile(installedPath, 'utf8')).toBe('keep me');
  });

  test('--force replaces only SKILL.md without confirmation', async () => {
    const target = await temporaryTarget();
    const installedPath = join(target, 'SKILL.md');
    const unrelatedPath = join(target, 'notes.txt');
    await mkdir(target, { recursive: true });
    await writeFile(installedPath, 'old skill');
    await writeFile(unrelatedPath, 'preserve me');

    expect(
      await installSkill({
        target,
        force: true,
        confirmOverwrite: async () => {
          throw new Error('confirmation should not run');
        },
      })
    ).toEqual({ status: 'installed', path: installedPath });
    expect(await readFile(installedPath)).toEqual(await readFile(assetPath));
    expect(await readFile(unrelatedPath, 'utf8')).toBe('preserve me');
  });
});
