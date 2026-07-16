import { describe, expect, test } from 'bun:test';
import { createTracker } from '../src/tracker/index.ts';

describe('tracker interface', () => {
  test('keeps its workspace root as composition configuration', () => {
    expect(createTracker('/tmp/workspace')).toEqual({
      workspaceRoot: '/tmp/workspace',
    });
  });
});
