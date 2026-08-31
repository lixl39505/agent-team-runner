const mockSources = {
  './core/config.js': `
    export const loadConfig = (repoRoot) => {
      if (process.env.AGENT_TEAM_CLI_THROW_STRING) throw 'mock string failure';
      if (process.env.AGENT_TEAM_CLI_THROW_MESSAGE) {
        const error = new Error('mock error message');
        error.stack = undefined;
        throw error;
      }
      return { version: 3, workspace: { repoRoot, stateDir: repoRoot + '/state', worktreesDir: repoRoot + '/worktrees', baseRef: 'HEAD', branchPrefix: 'agent-team' }, retry: { maxPlanAttempts: 2, maxWorkerAttempts: 2, maxReviewCycles: 2 }, status: { pollIntervalMs: 2000 }, agents: {
        'with-model': { backend: 'claude', model: 'alpha' },
        'without-model': { backend: 'opencode' }
      }, roles: {} };
    };
    export const applyOverrides = (config) => config;
    export const initConfig = (repoRoot) => repoRoot + '/config.yml';
  `,
  './core/db.js': `
    export class StateDatabase {
      close() {}
      getRun() { return { id: 'run', rolesJson: null, manifestJson: null }; }
      listRuns() { return []; }
      listTasks() { return []; }
      updateRun() {}
    }
  `,
  './core/files.js': `export const ensureGitignore = () => {}; export const syncSkills = () => ['skill'];`,
  './core/planner.js': `export const planRun = async () => 'run';`,
  './core/orchestrator.js': `export const runOrchestrator = async () => {};`,
  './core/status.js': `export const formatRunStatus = () => 'status';`,
  './core/git.js': `export const ensureGitRepo = async () => {}; export const execFile = async () => ({});`,
  './agent/registry.js': `
    const backends = {
      claude: {
        discover: async () => ({ installed: true, authed: false }),
        listModels: async () => Array.from({ length: 7 }, (_, index) => ({ id: 'model-' + index }))
      },
      codex: {
        discover: async () => ({ installed: true, version: 'new-codex' }),
        listModels: async () => { throw 'string enumeration failure'; }
      },
      opencode: {
        discover: async () => ({ installed: false }),
        listModels: async () => []
      }
    };
    export const buildBackends = () => backends;
    export const disposeBackends = () => {};
    export const parseSnapshot = () => undefined;
    export const snapshotAgents = () => ({ roles: {
      lead: { agent: 'with-model', backend: 'claude', model: 'alpha', source: 'mock' },
      worker: { agent: 'without-model', backend: 'opencode', source: 'mock' }
    } });
  `,
  './agent/codex/generated.js': `export const generatedProtocolVersion = () => 'old-codex';`,
  './core/agent-config.js': `export const backendCommand = () => ''; export const isBackendId = (value) => ['claude', 'codex', 'opencode'].includes(value); export const isValidAgentName = () => true; export const validateAgents = () => ({ ok: true, errors: ['syntax error'], warnings: ['syntax warning'] });`,
  './core/preflight.js': `
    export const bindingsForRun = () => [];
    export const checkAgentAvailability = async () => ({ ok: true, errors: ['availability error'], warnings: ['availability warning'] });
    export const probeAll = async () => [
      { backend: 'claude', model: 'alpha', ok: true },
      { backend: 'codex', ok: false, error: 'probe failed' },
      { backend: 'opencode', ok: false }
    ];
  `,
  './agent/approval.js': `export class TerminalApprovalBroker { request() {}; requestUserInput() {}; close() {} }`,
  './daemon-cli.js': `export const runDaemonCli = async () => {};`,
  './mcp-cli.js': `export const runMcpCli = async () => {};`
};

export async function resolve(specifier, context, nextResolve) {
  if (context.parentURL?.endsWith('/dist/cli.js') && mockSources[specifier]) {
    return { url: `data:text/javascript,${encodeURIComponent(mockSources[specifier])}`, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
