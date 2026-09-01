import koffi from 'koffi';

const GENERIC_READ = 0x80000000;
const GENERIC_WRITE = 0x40000000;
const READ_CONTROL = 0x00020000;
const WRITE_DAC = 0x00040000;
const FILE_SHARE_READ = 0x00000001;
const FILE_SHARE_WRITE = 0x00000002;
const OPEN_EXISTING = 3;
const SE_KERNEL_OBJECT = 6;
const DACL_SECURITY_INFORMATION = 0x00000004;
const PROTECTED_DACL_SECURITY_INFORMATION = 0x80000000;
const SDDL_REVISION_1 = 1;

const kernel32 = koffi.load('kernel32.dll');
const advapi32 = koffi.load('advapi32.dll');
const createFile = kernel32.func('__stdcall', 'CreateFileW', 'void *', [
  'str16', 'uint32', 'uint32', 'void *', 'uint32', 'uint32', 'void *'
]);
const closeHandle = kernel32.func('__stdcall', 'CloseHandle', 'int', ['void *']);
const getLastError = kernel32.func('__stdcall', 'GetLastError', 'uint32', []);
const localFree = kernel32.func('__stdcall', 'LocalFree', 'void *', ['void *']);
const convertSecurityDescriptor = advapi32.func(
  '__stdcall', 'ConvertStringSecurityDescriptorToSecurityDescriptorW', 'int', ['str16', 'uint32', 'void **', 'uint32 *']
);
const getSecurityDescriptorDacl = advapi32.func(
  '__stdcall', 'GetSecurityDescriptorDacl', 'int', ['void *', 'int *', 'void **', 'int *']
);
const setSecurityInfo = advapi32.func(
  '__stdcall', 'SetSecurityInfo', 'uint32', ['void *', 'uint32', 'uint32', 'void *', 'void *', 'void *', 'void *']
);

function invalidHandle(handle: bigint | null): boolean {
  if (handle === null || handle === 0n) return true;
  return handle === (process.arch === 'ia32' ? 0xffffffffn : 0xffffffffffffffffn);
}

function windowsError(operation: string, code: number): Error {
  return new Error(`${operation} failed with Windows error ${code}`);
}

/**
 * Replaces Node's default named-pipe DACL with one granting access solely to
 * the creating process's user (the object owner). Node does not expose the
 * server pipe HANDLE, so this opens a short-lived local client handle after
 * listen has completed. A hostile client can race that interval; callers must
 * treat a failure as fatal and documentation must retain this TOCTOU caveat.
 */
export function restrictWindowsNamedPipeToOwner(path: string): void {
  if (process.platform !== 'win32') return;
  const pipe = createFile(
    path,
    GENERIC_READ + GENERIC_WRITE + READ_CONTROL + WRITE_DAC,
    FILE_SHARE_READ | FILE_SHARE_WRITE,
    null,
    OPEN_EXISTING,
    0,
    null
  ) as bigint | null;
  if (invalidHandle(pipe)) throw windowsError('CreateFileW for named pipe', getLastError() as number);

  let securityDescriptor: (bigint | null)[] = [null];
  try {
    if (!convertSecurityDescriptor('D:P(A;;GA;;;OW)', SDDL_REVISION_1, securityDescriptor, [0])) {
      throw windowsError('ConvertStringSecurityDescriptorToSecurityDescriptorW', getLastError() as number);
    }
    const dacl: (bigint | null)[] = [null];
    if (!getSecurityDescriptorDacl(securityDescriptor[0], [0], dacl, [0]) || dacl[0] === null) {
      throw windowsError('GetSecurityDescriptorDacl', getLastError() as number);
    }
    const status = setSecurityInfo(
      pipe,
      SE_KERNEL_OBJECT,
      DACL_SECURITY_INFORMATION + PROTECTED_DACL_SECURITY_INFORMATION,
      null,
      null,
      dacl[0],
      null
    ) as number;
    if (status !== 0) throw windowsError('SetSecurityInfo for named pipe', status);
  } finally {
    if (securityDescriptor[0] !== null) localFree(securityDescriptor[0]);
    closeHandle(pipe);
  }
}
