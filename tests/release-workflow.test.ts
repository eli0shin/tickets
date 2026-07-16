import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';

const workflowPath = join(import.meta.dir, '../.github/workflows/version.yml');
const releaseCondition = "steps.check-release.outputs.needs_binaries == 'true'";
const artifacts = [
  'tickets-linux-x64',
  'tickets-linux-arm64',
  'tickets-darwin-x64',
  'tickets-darwin-arm64',
];

type WorkflowStep = {
  name?: string;
  uses?: string;
  if?: string;
  run?: string;
  with?: Record<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function workflowSteps(source: string): WorkflowStep[] {
  const workflow: unknown = parse(source);
  if (!isRecord(workflow)) throw new Error('Invalid release workflow');
  const jobs = workflow['jobs'];
  if (!isRecord(jobs)) throw new Error('Missing workflow jobs');
  const version = jobs['version'];
  if (!isRecord(version)) throw new Error('Missing version job');
  const steps = version['steps'];
  if (!Array.isArray(steps)) throw new Error('Missing version workflow steps');

  return steps.map((value) => {
    if (!isRecord(value)) throw new Error('Invalid workflow step');
    return {
      name: typeof value['name'] === 'string' ? value['name'] : undefined,
      uses: typeof value['uses'] === 'string' ? value['uses'] : undefined,
      if: typeof value['if'] === 'string' ? value['if'] : undefined,
      run: typeof value['run'] === 'string' ? value['run'] : undefined,
      with: isRecord(value['with']) ? value['with'] : undefined,
    };
  });
}

function namedStep(steps: WorkflowStep[], name: string): WorkflowStep {
  const step = steps.find((candidate) => candidate.name === name);
  if (step === undefined) throw new Error(`Missing workflow step: ${name}`);
  return step;
}

function listedArtifacts(run: string | undefined): string[] {
  if (run === undefined) throw new Error('Workflow step has no run command');
  return run
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('tickets-'))
    .map((line) => line.replace(/ \\$/, ''));
}

describe('release workflow', () => {
  test('repairs every native artifact from the exact release tag', async () => {
    const source = await readFile(workflowPath, 'utf8');
    const steps = workflowSteps(source);

    const checkout = steps.find((step) => step.uses === 'actions/checkout@v7');
    expect(checkout?.with?.['fetch-depth']).toBe(0);

    const detection = namedStep(steps, 'Check if release needs binaries');
    expect(listedArtifacts(detection.run)).toEqual(artifacts);
    expect(detection.run).toContain('needs_binaries=$NEEDS_BINARIES');
    expect(detection.run).toContain('version=$VERSION');

    const changesets = namedStep(
      steps,
      'Create Release Pull Request or Publish'
    );
    expect(changesets.uses).toBe('changesets/action@v1');

    const upload = namedStep(steps, 'Upload binaries to release');
    const releaseSteps = [
      namedStep(steps, 'Check out release commit'),
      namedStep(steps, 'Clean release dependencies'),
      namedStep(steps, 'Install release dependencies'),
      namedStep(steps, 'Build linux-x64'),
      namedStep(steps, 'Build linux-arm64'),
      namedStep(steps, 'Build darwin-x64'),
      namedStep(steps, 'Build darwin-arm64'),
      upload,
    ];
    for (const step of releaseSteps) {
      expect(step.if).toBe(releaseCondition);
    }

    expect(releaseSteps[0]?.run).toBe(
      'git checkout --detach --force "refs/tags/${{ steps.check-release.outputs.version }}"'
    );
    expect(releaseSteps[1]?.run).toBe('rm -rf node_modules');
    expect(releaseSteps[2]?.run).toBe('bun install --frozen-lockfile');

    for (const [step, target, artifact] of [
      [releaseSteps[3], 'bun-linux-x64', artifacts[0]],
      [releaseSteps[4], 'bun-linux-arm64', artifacts[1]],
      [releaseSteps[5], 'bun-darwin-x64', artifacts[2]],
      [releaseSteps[6], 'bun-darwin-arm64', artifacts[3]],
    ] as const) {
      expect(step.run).toBe(
        `bun build src/cli.ts --compile --target=${target} --outfile ${artifact}`
      );
    }

    expect(listedArtifacts(upload.run)).toEqual(artifacts);
    expect(upload.run).toContain(
      'gh release upload "${{ steps.check-release.outputs.version }}"'
    );
    expect(upload.run).toContain('--clobber');

    let previousIndex = -1;
    for (const step of [changesets, detection, ...releaseSteps]) {
      const index = steps.indexOf(step);
      expect(index).toBeGreaterThan(previousIndex);
      previousIndex = index;
    }
  });
});
