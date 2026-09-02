import assert from 'node:assert/strict';
import { test, vi } from 'vitest';

const calls = [];
const ffi = {
  createFileResult: 42n,
  convertResult: 1,
  daclResult: 1,
  dacl: 101n,
  setSecurityStatus: 0
};

vi.mock('koffi', () => ({
  default: {
    load() {
      return {
        func(_convention, name) {
          return (...args) => {
            calls.push({ name, args });
            if (name === 'CreateFileW') return ffi.createFileResult;
            if (name === 'GetLastError') return 5;
            if (name === 'ConvertStringSecurityDescriptorToSecurityDescriptorW') {
              if (ffi.convertResult) args[2][0] = 100n;
              return ffi.convertResult;
            }
            if (name === 'GetSecurityDescriptorDacl') {
              if (ffi.daclResult) args[2][0] = ffi.dacl;
              return ffi.daclResult;
            }
            if (name === 'SetSecurityInfo') return ffi.setSecurityStatus;
            if (name === 'CloseHandle' || name === 'LocalFree') return 0n;
            throw new Error(`unexpected FFI call: ${name}`);
          };
        }
      };
    }
  }
}));

const { restrictWindowsNamedPipeToOwner } = await import('../src/daemon/windows-named-pipe.ts');

function resetFfi() {
  calls.length = 0;
  Object.assign(ffi, {
    createFileResult: 42n,
    convertResult: 1,
    daclResult: 1,
    dacl: 101n,
    setSecurityStatus: 0
  });
}

async function asWindows(run, arch) {
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  const archDescriptor = Object.getOwnPropertyDescriptor(process, 'arch');
  Object.defineProperty(process, 'platform', { value: 'win32' });
  if (arch) Object.defineProperty(process, 'arch', { value: arch });
  try {
    await run();
  } finally {
    Object.defineProperty(process, 'platform', platformDescriptor);
    if (arch) Object.defineProperty(process, 'arch', archDescriptor);
  }
}

test('Windows pipe DACL repair grants only the pipe owner and releases FFI resources', async () => {
  resetFfi();
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

test('Windows pipe DACL repair is a no-op outside Windows', () => {
  resetFfi();
  restrictWindowsNamedPipeToOwner('\\\\.\\pipe\\agent-team');
  assert.deepEqual(calls, []);
});

test('Windows pipe DACL repair rejects invalid handles on native and ia32 architectures', async () => {
  for (const [arch, handle] of [['arm64', 0xffffffffffffffffn], ['ia32', 0xffffffffn], ['ia32', null], ['ia32', 0n]]) {
    resetFfi();
    ffi.createFileResult = handle;
    await asWindows(() => {
      assert.throws(
        () => restrictWindowsNamedPipeToOwner('\\\\.\\pipe\\agent-team'),
        /CreateFileW for named pipe failed with Windows error 5/
      );
    }, arch);
    assert.deepEqual(calls.map((call) => call.name), ['CreateFileW', 'GetLastError']);
  }
});

test('Windows pipe DACL repair releases its handle when descriptor conversion fails', async () => {
  resetFfi();
  ffi.convertResult = 0;
  await asWindows(() => {
    assert.throws(
      () => restrictWindowsNamedPipeToOwner('\\\\.\\pipe\\agent-team'),
      /ConvertStringSecurityDescriptorToSecurityDescriptorW failed with Windows error 5/
    );
  });
  assert.deepEqual(calls.map((call) => call.name), [
    'CreateFileW', 'ConvertStringSecurityDescriptorToSecurityDescriptorW', 'GetLastError', 'CloseHandle'
  ]);
});

test('Windows pipe DACL repair releases its descriptor and handle when DACL lookup fails', async () => {
  for (const [daclResult, dacl] of [[0, 101n], [1, null]]) {
    resetFfi();
    ffi.daclResult = daclResult;
    ffi.dacl = dacl;
    await asWindows(() => {
      assert.throws(
        () => restrictWindowsNamedPipeToOwner('\\\\.\\pipe\\agent-team'),
        /GetSecurityDescriptorDacl failed with Windows error 5/
      );
    });
    assert.deepEqual(calls.slice(-2).map((call) => call.name), ['LocalFree', 'CloseHandle']);
  }
});

test('Windows pipe DACL repair reports SetSecurityInfo failures after releasing FFI resources', async () => {
  resetFfi();
  ffi.setSecurityStatus = 123;
  await asWindows(() => {
    assert.throws(
      () => restrictWindowsNamedPipeToOwner('\\\\.\\pipe\\agent-team'),
      /SetSecurityInfo for named pipe failed with Windows error 123/
    );
  });
  assert.deepEqual(calls.slice(-2).map((call) => call.name), ['LocalFree', 'CloseHandle']);
});
