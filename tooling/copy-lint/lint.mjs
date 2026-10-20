// AST-based extraction + allowlist handling. Uses the repo's TypeScript compiler API.
import { createRequire } from "node:module";
import { matchText, CONSENT_RE } from "./rules.mjs";
const ts = createRequire(import.meta.url)("typescript");

// Placeholder for a ${expr} substitution: not a digit, so "${n} people viewing" is not a literal number.
const SUB = "\u0001";

const ALLOW_RE = /copy-lint-allow\(([^)]*)\)\s*:?\s*(.*)$/;
// A valid justification must name the server-derived source, e.g.
//   server-derived: GET /v1/products/{id} (stock.remaining)
const JUSTIFICATION_RE = /server-derived:\s*\S.{3,}/i;

function lineOf(sf, pos) {
  return sf.getLineAndCharacterOfPosition(pos).line + 1;
}

function isSkippableString(node) {
  const p = node.parent;
  if (!p) return false;
  if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p) || ts.isExternalModuleReference(p)) return true;
  if (ts.isLiteralTypeNode(p)) return true;
  if (ts.isPropertyAssignment(p) && p.name === node) return true;
  if (ts.isPropertySignature(p) || ts.isEnumMember(p)) return true;
  if (ts.isElementAccessExpression(p) && p.argumentExpression === node) return true;
  if (ts.isCaseClause(p)) return true;
  if (ts.isBinaryExpression(p) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(p.operatorToken.kind)) return true;
  // JSX attribute values like testID="x", style props, etc.: only user-visible attrs are copy.
  if (ts.isJsxAttribute(p)) {
    const name = p.name.getText();
    return !/^(title|label|placeholder|accessibilityLabel|aria-label|alt|text|message|description|hint|subtitle|heading|caption|helperText|errorText|children)$/.test(name);
  }
  if (ts.isCallExpression(p) && ts.isIdentifier(p.expression) && p.expression.text === "require") return true;
  return false;
}

/** Extract copy strings. Returns [{text, line, templated}] */
export function extractStrings(sf) {
  const out = [];
  const visit = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (!isSkippableString(node)) out.push({ text: node.text, line: lineOf(sf, node.getStart(sf)) });
    } else if (ts.isTemplateExpression(node)) {
      let text = node.head.text;
      for (const s of node.templateSpans) text += SUB + s.literal.text;
      out.push({ text, line: lineOf(sf, node.getStart(sf)), templated: true });
    } else if (ts.isJsxText(node)) {
      const t = node.text.replace(/\s+/g, " ").trim();
      if (t) out.push({ text: t, line: lineOf(sf, node.getStart(sf) + (node.text.length - node.text.trimStart().length)) });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

const SERVER_TIME_RE = /server_?time|server_?now|server_?offset|serverClock|expires_?at|ends_?at|endsAt|deadline_?at|useServerTime|fromServer/i;

function nameOf(n) {
  if (!n) return "";
  if (ts.isIdentifier(n) || ts.isStringLiteral(n)) return n.text;
  return n.getText();
}

function isTrue(n) {
  if (!n) return false;
  if (n.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (ts.isJsxExpression(n)) return isTrue(n.expression);
  if (ts.isParenthesizedExpression(n)) return isTrue(n.expression);
  return false;
}

/** Structural (non-text) rules: pre-ticked consent and non-server countdowns. */
export function structuralFindings(sf, sourceText) {
  const out = [];
  const add = (node, rule, category, message, match) =>
    out.push({ rule, category, message, match, line: lineOf(sf, node.getStart(sf)), lang: "n/a" });

  const consentContext = (node) => {
    for (let n = node.parent; n; n = n.parent) {
      if (ts.isPropertyAssignment(n) || ts.isVariableDeclaration(n) || ts.isPropertyDeclaration(n)) {
        if (CONSENT_RE.test(nameOf(n.name))) return nameOf(n.name);
      }
      if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
        const txt = n.getText(sf);
        const m = CONSENT_RE.exec(txt);
        if (m) return m[0];
      }
      if (ts.isFunctionDeclaration(n) || ts.isArrowFunction(n) || ts.isClassDeclaration(n)) break;
    }
    return null;
  };

  const CHECK_PROPS = /^(granted|checked|defaultChecked|selected|accepted|optedIn|optIn|enabled|value|defaultValue|isChecked|consented)$/;
  let hasCountdown = null;

  const visit = (node) => {
    if (ts.isPropertyAssignment(node) && CHECK_PROPS.test(nameOf(node.name)) && isTrue(node.initializer)) {
      const ctx = consentContext(node);
      if (ctx) add(node, "prechecked-consent", "dark-pattern", "Consent control defaults to granted (spec B1: never pre-ticked)", `${nameOf(node.name)}: true in ${ctx}`);
    }
    if (ts.isJsxAttribute(node)) {
      const n = node.name.getText();
      const bare = node.initializer === undefined;
      if (CHECK_PROPS.test(n) && (isTrue(node.initializer) || (bare && /^default?Checked$|^checked$/.test(n)))) {
        const opening = node.parent.parent;
        const txt = opening.getText(sf);
        const m = CONSENT_RE.exec(txt) || consentContext(node);
        if (m) add(node, "prechecked-consent", "dark-pattern", "Consent control defaults to granted (spec B1: never pre-ticked)", `<${n}> on consent control`);
      }
    }
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isCallExpression(node.initializer) &&
        ts.isIdentifier(node.initializer.expression) && node.initializer.expression.text === "useState" &&
        isTrue(node.initializer.arguments[0])) {
      const nm = ts.isArrayBindingPattern(node.name) ? node.name.getText(sf) : nameOf(node.name);
      if (CONSENT_RE.test(nm)) add(node, "prechecked-consent", "dark-pattern", "Consent state initialised to true (spec B1: never pre-ticked)", `useState(true) for ${nm}`);
    }
    // Countdown not from server: a component/identifier named *Countdown*/*Timer* whose file never references a server time source.
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && /countdown|timer/i.test(node.tagName.getText(sf)) && !/Timer(?:Provider|Context)$/.test(node.tagName.getText(sf))) {
      if (hasCountdown === null) hasCountdown = !SERVER_TIME_RE.test(sourceText);
      if (hasCountdown) add(node, "countdown-not-server", "urgency", "Countdown component rendered without a server timestamp source in the file", node.tagName.getText(sf));
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "setInterval") {
      const body = node.arguments[0] ? node.arguments[0].getText(sf) : "";
      if (/(?:remaining|secondsLeft|timeLeft|countdown|left)\s*(?:-=|--|-\s*1|=\s*\w+\s*-\s*1)|set\w*\(\s*\(?\w*\)?\s*=>\s*\w+\s*-\s*1/i.test(body) && !SERVER_TIME_RE.test(sourceText)) {
        add(node, "countdown-not-server", "urgency", "Client-side decrementing timer with no server timestamp source", body.slice(0, 60));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** Apply inline allowlist: a comment on the finding line or the line above. */
function applyInlineAllow(findings, lines) {
  const kept = [];
  const invalid = [];
  for (const f of findings) {
    let allowed = false;
    for (const ln of [f.line, f.line - 1, f.line - 2]) {
      const src = lines[ln - 1];
      if (src === undefined) continue;
      const m = ALLOW_RE.exec(src);
      if (!m) continue;
      const rules = m[1].split(",").map((s) => s.trim());
      if (!rules.includes(f.rule) && !rules.includes("*")) continue;
      if (!JUSTIFICATION_RE.test(m[2])) {
        invalid.push({ rule: "allow-invalid", category: "allowlist", lang: "n/a", line: ln, match: src.trim(), message: "copy-lint-allow needs 'server-derived: <source>' justification" });
        continue;
      }
      allowed = true;
      break;
    }
    if (!allowed) kept.push(f);
  }
  return [...kept, ...invalid];
}

export function lintSource(fileName, sourceText, options = {}) {
  const kind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, kind);
  const findings = [];
  for (const s of extractStrings(sf)) {
    for (const h of matchText(s.text.replaceAll(SUB, "{x}"))) {
      // Numeric rules are not violations when the number is a substitution (templated from props).
      findings.push({ ...h, line: s.line });
    }
  }
  findings.push(...structuralFindings(sf, sourceText));
  const lines = sourceText.split(/\r?\n/);
  let result = applyInlineAllow(findings, lines);
  const central = options.allowlist ?? [];
  result = result.filter((f) => !central.some((a) => a.file === fileName && a.rule === f.rule && (!a.match || f.match.includes(a.match)) && JUSTIFICATION_RE.test(a.justification ?? "")));
  // dedupe
  const seen = new Set();
  return result
    .filter((f) => { const k = `${f.rule}:${f.line}:${f.match}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .map((f) => ({ file: fileName, ...f }))
    .sort((a, b) => a.line - b.line);
}
