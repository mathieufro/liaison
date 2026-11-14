// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Import attributes in a handler bundle, found before Bun reads the bundle.
 *
 * Bun runs a macro import (`import { f } from "m" with { type: "macro" }`) while
 * it parses: `Bun.Transpiler#transformSync`, `#scan` and `Bun.build` all run it,
 * in the host process. So the host never hands Bun a bundle that carries an
 * import attribute. No handler bundle needs one: the sandbox evaluates a bundle
 * as a script that cannot import.
 *
 * The bundle is read with the TypeScript parser, which never runs code, so the
 * check is syntactic: strings, template literals, comments and regular
 * expression literals that only contain `with {` are no attribute. A bundle the
 * parser cannot read is refused too, so text it reads one way and Bun another
 * never reaches Bun.
 */
import type ts from "typescript"

/**
 * Verdicts already reached, keyed on the bundle's SHA-256 (a collision-resistant
 * hash: a bundle cannot borrow another's verdict) and its length. Parsing a large
 * bundle costs the API thread hundreds of milliseconds of synchronous work, and the
 * same bytes are checked at activation and again before each export-only build.
 */
const verdicts = new Map<string, string | null>()
const MAX_VERDICTS = 256

/** Why `source` must not reach Bun's parser, or null when it may. */
export async function importAttributeIssue(source: string): Promise<string | null> {
  const key = `${new Bun.CryptoHasher("sha256").update(source).digest("hex")}:${source.length}`
  if (verdicts.has(key)) {
    const known = verdicts.get(key) ?? null
    verdicts.delete(key)
    verdicts.set(key, known)
    return known
  }
  const verdict = await parseForImportAttributes(source)
  verdicts.set(key, verdict)
  while (verdicts.size > MAX_VERDICTS) {
    const oldest = verdicts.keys().next().value
    if (oldest === undefined) break
    verdicts.delete(oldest)
  }
  return verdict
}

async function parseForImportAttributes(source: string): Promise<string | null> {
  const t = (await import("typescript")).default
  const sf = t.createSourceFile("bundle.js", source, t.ScriptTarget.Latest, false, t.ScriptKind.JS)
  const syntax =
    (sf as unknown as { parseDiagnostics?: ts.DiagnosticWithLocation[] }).parseDiagnostics ?? []
  const first = syntax[0]
  if (first) {
    return `it does not parse at line ${lineOf(sf, first.start)}: ${t.flattenDiagnosticMessageText(first.messageText, "\n")}`
  }
  let found: string | null = null
  const visit = (node: ts.Node): void => {
    if (found) return
    if ((t.isImportDeclaration(node) || t.isExportDeclaration(node)) && node.attributes) {
      found = `it carries an import attribute (\`with { ... }\` or \`assert { ... }\`) at line ${lineOf(sf, node.pos)}`
      return
    }
    if (
      t.isCallExpression(node) &&
      node.expression.kind === t.SyntaxKind.ImportKeyword &&
      node.arguments.length > 1
    ) {
      found = `it passes import options (\`import(x, { with: ... })\`) at line ${lineOf(sf, node.pos)}`
      return
    }
    t.forEachChild(node, visit)
  }
  visit(sf)
  return found
}

function lineOf(sf: ts.SourceFile, pos: number): number {
  return sf.getLineAndCharacterOfPosition(Math.max(0, pos)).line + 1
}

/**
 * Why `source` is not a plain script, or null when it is one. A plain script (an
 * import transform, a PDF template bundle, the code of a draft's preview) may
 * load nothing and export nothing: it has no import or export declaration, no
 * `import(...)`, no `import.meta` and no `return` outside a function. Read with
 * the TypeScript parser, which never runs code, so the answer does not depend on
 * how the text is spaced, commented or escaped. A script the parser cannot read
 * is refused.
 */
export async function plainScriptIssue(source: string): Promise<string | null> {
  const t = (await import("typescript")).default
  const sf = t.createSourceFile("script.js", source, t.ScriptTarget.Latest, false, t.ScriptKind.JS)
  const syntax =
    (sf as unknown as { parseDiagnostics?: ts.DiagnosticWithLocation[] }).parseDiagnostics ?? []
  const first = syntax[0]
  if (first) {
    return `it does not parse at line ${lineOf(sf, first.start)}: ${t.flattenDiagnosticMessageText(first.messageText, "\n")}`
  }
  let found: string | null = null
  const at = (node: ts.Node) => `at line ${lineOf(sf, node.getStart(sf))}`
  const visit = (node: ts.Node, inFunction: boolean): void => {
    if (found) return
    if (t.isImportDeclaration(node) || t.isImportEqualsDeclaration(node)) {
      found = `it imports a module ${at(node)}; a script may import nothing`
      return
    }
    if (
      t.isExportDeclaration(node) ||
      t.isExportAssignment(node) ||
      (t.canHaveModifiers(node) &&
        t.getModifiers(node)?.some((m) => m.kind === t.SyntaxKind.ExportKeyword))
    ) {
      found = `it exports ${at(node)}; a script may export nothing`
      return
    }
    if (t.isCallExpression(node) && node.expression.kind === t.SyntaxKind.ImportKeyword) {
      found = `it loads a module (\`import(...)\`) ${at(node)}; a script may import nothing`
      return
    }
    if (t.isMetaProperty(node) && node.keywordToken === t.SyntaxKind.ImportKeyword) {
      found = `it reads \`import.meta\` ${at(node)}; a script is no module`
      return
    }
    if (t.isReturnStatement(node) && !inFunction) {
      found = `it returns outside a function ${at(node)}`
      return
    }
    const nested = inFunction || t.isFunctionLike(node) || t.isClassStaticBlockDeclaration(node)
    t.forEachChild(node, (child) => visit(child, nested))
  }
  visit(sf, false)
  return found
}

/**
 * The number of top-level statements of `source`, or null when it does not
 * parse: a script wrapped in a function scope must stay one statement, so a
 * script whose text closes the wrapper is refused.
 */
export async function topLevelStatementCount(source: string): Promise<number | null> {
  const t = (await import("typescript")).default
  const sf = t.createSourceFile("module.js", source, t.ScriptTarget.Latest, false, t.ScriptKind.JS)
  const syntax =
    (sf as unknown as { parseDiagnostics?: ts.DiagnosticWithLocation[] }).parseDiagnostics ?? []
  return syntax.length > 0 ? null : sf.statements.length
}

// -- Checked sources ---------------------------------------------------------------
//
// The only door from text that is not the repo's own (a package's bundle, an org's
// script) to Bun's parser in this process. A `CheckedSource` is made here and only
// here, after one of the checks above passed; `transpileChecked` takes nothing
// else. The brand is a private class field, so a string or an object literal does
// not typecheck as one, and a cast does not pass the run-time test either. The
// guard apps/api/src/tests/untrusted-host-build.test.ts holds every other
// `Bun.build` / `Bun.Transpiler` / `Bun.plugin` call site to repo-own input.

/** What a checked source passed: no import attribute at all, or a plain script. */
export type CheckKind = "attribute-free" | "plain-script"

class Checked<K extends CheckKind> {
  readonly #kind: K
  readonly text: string
  constructor(text: string, kind: K) {
    this.text = text
    this.#kind = kind
  }
  get kind(): K {
    return this.#kind
  }
  static checkedBrandHeld(value: unknown): value is Checked<CheckKind> {
    return typeof value === "object" && value !== null && #kind in value
  }
}

/** Text with no import attribute and no import options, read by the TypeScript parser. */
export type CheckedSource = Checked<CheckKind>
/** A plain script (plainScriptIssue): it imports, exports and loads nothing. */
export type CheckedScript = Checked<"plain-script">

export type CheckResult<T> = { ok: true; source: T } | { ok: false; issue: string }

/** `source` as a CheckedSource when it carries no import attribute (importAttributeIssue). */
export async function checkAttributeFree(source: string): Promise<CheckResult<CheckedSource>> {
  const issue = await importAttributeIssue(source)
  return issue === null
    ? { ok: true, source: new Checked(source, "attribute-free") }
    : { ok: false, issue }
}

/**
 * `source` as a CheckedScript when it is a plain script (plainScriptIssue). A plain
 * script imports nothing, so it carries no attribute either.
 */
export async function checkPlainScript(source: string): Promise<CheckResult<CheckedScript>> {
  const issue = await plainScriptIssue(source)
  return issue === null
    ? { ok: true, source: new Checked(source, "plain-script") }
    : { ok: false, issue }
}

/** Whether `value` was made by one of the checks above (not a look-alike). */
export function isCheckedSource(value: unknown): value is CheckedSource {
  return Checked.checkedBrandHeld(value)
}

/**
 * Bun's transform of a checked source, read as JavaScript (as the check read it):
 * the only Bun parse of non-repo text in this process.
 */
export function transpileChecked(source: CheckedSource): string {
  if (!Checked.checkedBrandHeld(source))
    throw new TypeError("transpileChecked takes a checked source only")
  return new Bun.Transpiler({ loader: "js" }).transformSync(source.text)
}
