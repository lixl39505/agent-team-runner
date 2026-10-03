import { describe, expect, test } from 'bun:test';
import { closureOf, topologicalTasks, validateContract } from '../src/core/contract.ts';
import { minimalContract } from './helpers.ts';

describe('validateContract', () => {
  test('accepts a minimal valid contract', () => {
    const contract = validateContract(minimalContract());
    expect(contract.tasks).toHaveLength(2);
    expect(contract.project.id).toBe('demo');
  });

  test('rejects unknown top-level fields', () => {
    expect(() => validateContract(minimalContract({ extra: true }))).toThrow(/unknown field/);
  });

  test('rejects unknown task fields', () => {
    const doc = minimalContract();
    (doc.tasks as Record<string, unknown>[])[0]!.sneaky = 1;
    expect(() => validateContract(doc)).toThrow(/task\.sneaky/);
  });

  test('rejects bad task ids', () => {
    const doc = minimalContract();
    (doc.tasks as Record<string, unknown>[])[0]!.id = 'lower';
    expect(() => validateContract(doc)).toThrow(/must match/);
  });

  test('rejects duplicate ids', () => {
    const doc = minimalContract();
    (doc.tasks as Record<string, unknown>[])[1]!.id = 'API';
    expect(() => validateContract(doc)).toThrow(/duplicate task id/);
  });

  test('rejects unknown dependency', () => {
    const doc = minimalContract();
    (doc.tasks as Record<string, unknown>[])[0]!.dependsOn = ['NOPE'];
    expect(() => validateContract(doc)).toThrow(/unknown task/);
  });

  test('rejects dependency cycles', () => {
    const doc = minimalContract();
    (doc.tasks as Record<string, unknown>[])[0]!.dependsOn = ['WEB'];
    (doc.tasks as Record<string, unknown>[])[1]!.dependsOn = ['API'];
    expect(() => validateContract(doc)).toThrow(/cycle/);
  });

  test('rejects overlapping allowedPaths', () => {
    const doc = minimalContract();
    (doc.tasks as Record<string, unknown>[])[1]!.allowedPaths = ['src/api/handler.ts'];
    expect(() => validateContract(doc)).toThrow(/overlap/);
  });

  test('rejects empty allowedPaths and relative repoRoot', () => {
    expect(() =>
      validateContract({
        ...minimalContract(),
        tasks: [{ id: 'A1', title: 'x', allowedPaths: [] }],
      }),
    ).toThrow(/allowedPaths/);
    expect(() =>
      validateContract({
        version: 1,
        project: { id: 'd', repoRoot: 'relative/path', baseRef: 'main' },
        tasks: [{ id: 'A1', title: 'x', allowedPaths: ['a/**'] }],
      }),
    ).toThrow(/absolute/);
  });

  test('rejects malformed skill refs', () => {
    expect(() =>
      validateContract({
        ...minimalContract(),
        tasks: [
          {
            id: 'A1',
            title: 'x',
            allowedPaths: ['a/**'],
            implementationSkills: [{ name: 's', sha256: 'zz' }],
          },
        ],
      }),
    ).toThrow(/sha256/);
  });
});

describe('topologicalTasks', () => {
  test('dependencies come first', () => {
    const contract = validateContract({
      version: 1,
      project: { id: 'd', repoRoot: '/r', baseRef: 'main' },
      tasks: [
        { id: 'C1', title: 'c', allowedPaths: ['c/**'], dependsOn: ['B1'] },
        { id: 'B1', title: 'b', allowedPaths: ['b/**'], dependsOn: ['A1'] },
        { id: 'A1', title: 'a', allowedPaths: ['a/**'] },
      ],
    });
    expect(topologicalTasks(contract)).toEqual(['A1', 'B1', 'C1']);
  });
});

describe('closureOf', () => {
  test('includes transitive deps and self', () => {
    const contract = validateContract({
      version: 1,
      project: { id: 'd', repoRoot: '/r', baseRef: 'main' },
      tasks: [
        { id: 'A1', title: 'a', allowedPaths: ['a/**'] },
        { id: 'B1', title: 'b', allowedPaths: ['b/**'], dependsOn: ['A1'] },
        { id: 'C1', title: 'c', allowedPaths: ['c/**'], dependsOn: ['B1'] },
      ],
    });
    expect(closureOf(contract, 'C1')).toEqual(new Set(['A1', 'B1', 'C1']));
  });
});
