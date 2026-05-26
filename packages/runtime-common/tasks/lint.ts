import type { Linter } from 'eslint';
import Module from 'node:module';
import { extname, resolve } from 'node:path';

import type { Task } from './index';

import { jobIdentity } from '../index';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type LintMessageSource = 'eslint' | 'template-lint';

export interface LintMessage {
  ruleId: string | null;
  severity: 1 | 2; // ESLint convention: 1=warning, 2=error
  message: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  /** Which engine produced this finding. Optional for backwards compat. */
  source?: LintMessageSource;
}

export interface LintArgs {
  source: string;
  filename?: string;
}

export interface LintResult {
  output: string;
  fixed: boolean;
  messages: LintMessage[];
  /** True iff `messages` contains no error-severity entries. Optional for
   * backwards compat — callers can also compute from `messages`. */
  passed?: boolean;
}

// No coalesce handler: each lint enqueue carries its own `source` (the file
// the user is editing) and the caller awaits a result derived from THAT
// source. Two concurrent lint requests across instances are for distinct
// sources; coalescing would return one caller's lint output to a different
// caller. The work is also short and bucketed across 10 random concurrency
// groups, so duplicate-instance contention is negligible.

// ---------------------------------------------------------------------------
// Input bounds
// ---------------------------------------------------------------------------

const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Host config — single source of truth shared with `pnpm run lint`
// ---------------------------------------------------------------------------

// runtime-common lives at <repo>/packages/runtime-common; host is its sibling.
const HOST_PKG = resolve(__dirname, '..', '..', 'host');
const HOST_ESLINTRC = resolve(HOST_PKG, '.eslintrc.js');
const REPO_ROOT = resolve(__dirname, '..', '..', '..');

// pnpm doesn't hoist transitive deps. When ESLint resolves `parser:
// 'ember-eslint-parser'` declared in host/.eslintrc.js, it uses
// Module.createRequire(eslintrcPath) — and host doesn't depend on that
// parser directly. The pnpm-generated `eslint` bin wrapper works around
// this by extending NODE_PATH to include `.pnpm/node_modules`. Replicate
// that here so plugins/parsers referenced by string in host's config can
// resolve from this Node context.
let nodePathReady = false;
function ensurePnpmNodePath() {
  if (nodePathReady) return;
  const pnpmNodeModules = resolve(
    REPO_ROOT,
    'node_modules',
    '.pnpm',
    'node_modules',
  );
  process.env.NODE_PATH = process.env.NODE_PATH
    ? `${pnpmNodeModules}:${process.env.NODE_PATH}`
    : pnpmNodeModules;
  // _initPaths is a private but stable Node API used by the official
  // pnpm shim. It re-reads NODE_PATH into Module.globalPaths.
  (Module as unknown as { _initPaths(): void })._initPaths();
  nodePathReady = true;
}

// ---------------------------------------------------------------------------
// Engine caches — config resolution + plugin loading is heavy and never
// changes at runtime, so we instantiate once per worker process.
// ---------------------------------------------------------------------------

let cachedESLint: unknown;
async function getESLint(): Promise<any> {
  if (cachedESLint) return cachedESLint;
  ensurePnpmNodePath();
  // Import ESLint from host's own node_modules so plugin/parser resolution
  // inside ESLint follows host's dependency tree.
  const eslintApiPath = resolve(
    HOST_PKG,
    'node_modules',
    'eslint',
    'lib',
    'api.js',
  );
  const eslintModule = await import(/* webpackIgnore: true */ eslintApiPath);
  cachedESLint = new eslintModule.ESLint({
    cwd: HOST_PKG,
    overrideConfigFile: HOST_ESLINTRC,
    fix: true,
    // Submission/realm files are in-memory; don't apply host's .eslintignore
    // to them.
    ignore: false,
  });
  return cachedESLint;
}

let cachedTemplateLinter: unknown;
async function getTemplateLinter(): Promise<any> {
  if (cachedTemplateLinter) return cachedTemplateLinter;
  ensurePnpmNodePath();
  const tlModule = await import(
    // @ts-ignore no types for ember-template-lint
    /* webpackIgnore: true */ 'ember-template-lint'
  );
  const TemplateLinter = (tlModule as any).default ?? tlModule;
  cachedTemplateLinter = new TemplateLinter({ workingDir: HOST_PKG });
  return cachedTemplateLinter;
}

// ---------------------------------------------------------------------------
// File-extension routing
// ---------------------------------------------------------------------------

const ESLINT_EXTENSIONS = new Set(['.js', '.ts', '.gjs', '.gts']);
const TEMPLATE_LINT_EXTENSIONS = new Set(['.hbs', '.gts', '.gjs']);

// ---------------------------------------------------------------------------
// Task
// ---------------------------------------------------------------------------

export const lintSource: Task<LintArgs, LintResult> = ({ reportStatus, log }) =>
  async function (args) {
    const { jobInfo } = args as LintArgs & { jobInfo?: unknown };
    const filename = args.filename || 'input.gts';
    log.debug(
      `${jobIdentity(jobInfo as any)} starting lint-source for ${filename}`,
    );
    reportStatus(jobInfo as any, 'start');

    validateInput(args);

    const result = await lintOne(args.source, filename);

    log.debug(
      `${jobIdentity(jobInfo as any)} completed lint-source: ${result.messages.length} message(s), fixed=${result.fixed}`,
    );
    reportStatus(jobInfo as any, 'finish');
    return result;
  };

function validateInput(args: LintArgs): void {
  if (typeof (globalThis as any).document !== 'undefined') {
    throw new Error('Linting is not supported in the browser environment.');
  }
  if (typeof args?.source !== 'string') {
    throw new Error('lint-source: `source` must be a string');
  }
  if (Buffer.byteLength(args.source, 'utf8') > MAX_FILE_SIZE_BYTES) {
    throw new Error(`lint-source: source exceeds ${MAX_FILE_SIZE_BYTES} bytes`);
  }
}

async function lintOne(source: string, filename: string): Promise<LintResult> {
  const ext = extname(filename).toLowerCase();
  const messages: LintMessage[] = [];
  let working = source;
  let modified = false;

  if (ESLINT_EXTENSIONS.has(ext)) {
    const { output, messages: eslintMessages } = await runESLint(
      working,
      filename,
    );
    if (typeof output === 'string' && output !== working) {
      working = output;
      modified = true;
    }
    for (const m of eslintMessages) {
      messages.push({
        ruleId: m.ruleId ?? null,
        severity: (m.severity === 2 ? 2 : 1) as 1 | 2,
        message: m.message,
        line: m.line ?? 1,
        column: m.column ?? 1,
        endLine: m.endLine,
        endColumn: m.endColumn,
        source: 'eslint',
      });
    }
  }

  if (TEMPLATE_LINT_EXTENSIONS.has(ext)) {
    const { output, messages: tlMessages } = await runTemplateLint(
      working,
      filename,
    );
    if (typeof output === 'string' && output !== working) {
      working = output;
      modified = true;
    }
    for (const m of tlMessages) {
      messages.push({
        ruleId: m.rule ?? null,
        severity: (m.severity === 2 ? 2 : 1) as 1 | 2,
        message: m.message,
        line: m.line ?? 1,
        column: m.column ?? 1,
        endLine: m.endLine,
        endColumn: m.endColumn,
        source: 'template-lint',
      });
    }
  }

  const passed = !messages.some((m) => m.severity === 2);
  return {
    passed,
    output: working,
    fixed: modified,
    messages,
  };
}

async function runESLint(
  source: string,
  filename: string,
): Promise<{ output?: string; messages: Linter.LintMessage[] }> {
  const eslint = await getESLint();
  // Anchor the filePath at the host package root (NOT under `app/`).
  // host/.eslintrc.js has narrow overrides keyed on `app/**` and `tests/**`
  // (e.g. `import/order`) that should not apply to realm content lint —
  // those are host-source concerns, not submission concerns. The broader
  // `**/*.gts` / `**/*.{js,ts}` overrides still match and bring along the
  // full sharedBrowserConfig (ember, typescript, @cardstack/boxel rules).
  const filePath = resolve(HOST_PKG, filename);
  const results = await eslint.lintText(source, { filePath });
  const r = results[0] ?? {};
  return { output: r.output, messages: r.messages ?? [] };
}

async function runTemplateLint(
  source: string,
  filename: string,
): Promise<{ output?: string; messages: any[] }> {
  const linter = await getTemplateLinter();
  const result = await linter.verifyAndFix({
    source,
    moduleId: filename,
    filePath: resolve(HOST_PKG, filename),
  });
  return { output: result.output, messages: result.messages ?? [] };
}
