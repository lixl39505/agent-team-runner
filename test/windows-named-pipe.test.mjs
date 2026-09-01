import assert from 'node:assert/strict';
import { test, vi } from 'vitest';

const calls = [];
let createFileResult = 42n;

vi.mock('koffi', () => ({
  default: {
    load() {
      return {
        func(_convention, name) {
          return (...args) => {
            calls.push({ name, args });
            if (name === 'CreateFileW') return createFileResult;
            if (name === 'GetLastError') return 5;
            if (name === 'ConvertStringSecurityDescriptorToSecurityDescriptorW') {
              args[2][0] = 100n;
              return 1;
            }
            if (name === 'GetSecurityDescriptorDacl') {
              args[2][0] = 101n;
              return 1;
            }
            if (name === 'SetSecurityInfo') return 0;
            if (name === 'CloseHandle' || name === 'LocalFree') return 0n;
            throw new Error(`unexpected FFI call: ${name}`);
          };
        }
      };
    }
  }
}));

const { restrictWindowsNamedPipeToOwner } = await import('../src/daemon/windows-named-pipe.ts');

async function asWindows(run) {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    await run();
  } finally {
    Object.defineProperty(process, 'platform', descriptor);
  }
}

test('Windows pipe DACL repair grants only the pipe owner and releases FFI resources', async () => {
  calls.length = 0;
  createFileResult = 42n;
  await asWindows(() => restrictWindowsNamedPipeToOwner('\\\\.\\pipe\\agent-team'));

  assert.equal(calls[0].name, 'CreateFileW');
  assert.deepEqual(calls[1], {
    name: 'ConvertStringSecurityDescriptorToSecurityDescriptorW',
    args: ['D:P(A;;GA;;;OW)', 1, [100n], [0]]
  });
  assert.equal(calls[2].name, 'GetSecurityDescriptorDacl');
  assert.deepEqual(calls[3], {
    name: 'SetSecurityInfo',
    args: [42n, 6, 0x80000004, null, null, 101n, null]
  });
  assert.deepEqual(calls.slice(-2).map((call) => call.name), ['LocalFree', 'CloseHandle']);
});

test('Windows pipe DACL repair fails before exposing an unrepairable handle', async () => {
  calls.length = 0;
  createFileResult = 0xffffffffffffffffn;
  await asWindows(async () => {
    assert.throws(
      () => restrictWindowsNamedPipeToOwner('\\\\.\\pipe\\agent-team'),
      /CreateFileW for named pipe failed with Windows error 5/
    );
  });
  assert.deepEqual(calls.map((call) => call.name), ['CreateFileW', 'GetLastError']);
});
