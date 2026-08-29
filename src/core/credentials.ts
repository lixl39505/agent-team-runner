import { spawn } from 'node:child_process';

export const KEYCHAIN_SERVICE = 'agent-team-runner';

export interface SecurityResult {
  exitCode: number;
  stdout?: string;
}

export type SecurityRunner = (args: string[]) => Promise<SecurityResult>;

export interface CredentialStore {
  setApiKey(backend: string, profile: string, apiKey: string): Promise<void>;
  getApiKey(backend: string, profile: string): Promise<string | null>;
  hasApiKey(backend: string, profile: string): Promise<boolean>;
  deleteApiKey(backend: string, profile: string): Promise<boolean>;
}

export interface CredentialStoreOptions {
  platform?: NodeJS.Platform;
  runSecurity?: SecurityRunner;
}

export function createCredentialStore(options: CredentialStoreOptions = {}): CredentialStore {
  const platform = options.platform ?? process.platform;
  const runSecurity = options.runSecurity ?? runSecurityCommand;
  if (platform !== 'darwin') {
    return unsupportedStore(platform);
  }
  return new MacOSKeychainCredentialStore(runSecurity);
}

class MacOSKeychainCredentialStore implements CredentialStore {
  constructor(private readonly runSecurity: SecurityRunner) {}

  async setApiKey(backend: string, profile: string, apiKey: string): Promise<void> {
    if (!apiKey) throw new Error('API key must not be empty.');
    const result = await this.runSecurity([
      'add-generic-password', '-a', accountName(backend, profile), '-s', KEYCHAIN_SERVICE, '-w', apiKey, '-U'
    ]);
    if (result.exitCode !== 0) throw new Error('Unable to save credential in the macOS Keychain.');
  }

  async hasApiKey(backend: string, profile: string): Promise<boolean> {
    const result = await this.runSecurity([
      'find-generic-password', '-a', accountName(backend, profile), '-s', KEYCHAIN_SERVICE
    ]);
    if (result.exitCode === 0) return true;
    if (result.exitCode === 44) return false;
    throw new Error('Unable to check the macOS Keychain.');
  }

  async getApiKey(backend: string, profile: string): Promise<string | null> {
    const result = await this.runSecurity([
      'find-generic-password', '-a', accountName(backend, profile), '-s', KEYCHAIN_SERVICE, '-w'
    ]);
    if (result.exitCode === 0) return result.stdout?.trim() || null;
    if (result.exitCode === 44) return null;
    throw new Error('Unable to read the macOS Keychain.');
  }

  async deleteApiKey(backend: string, profile: string): Promise<boolean> {
    const result = await this.runSecurity([
      'delete-generic-password', '-a', accountName(backend, profile), '-s', KEYCHAIN_SERVICE
    ]);
    if (result.exitCode === 0) return true;
    if (result.exitCode === 44) return false;
    throw new Error('Unable to remove credential from the macOS Keychain.');
  }
}

function unsupportedStore(platform: string): CredentialStore {
  const error = (): never => { throw new Error(`Credential storage is only supported on macOS (current platform: ${platform}).`); };
  return {
    setApiKey: async () => error(),
    getApiKey: async () => error(),
    hasApiKey: async () => error(),
    deleteApiKey: async () => error()
  };
}

function accountName(backend: string, profile: string): string {
  return `${backend}/${profile}`;
}

function runSecurityCommand(args: string[]): Promise<SecurityResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('security', args, { shell: false, stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '';
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.once('error', () => reject(new Error('Unable to run the macOS security command.')));
    child.once('close', (exitCode) => resolve({ exitCode: exitCode ?? 1, stdout }));
  });
}
