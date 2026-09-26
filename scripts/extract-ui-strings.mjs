#!/usr/bin/env node
/**
 * Collects every piece of interface text written in the frontend source, for machine translation.
 *
 * The auto-translator (apps/frontend/src/lib/i18n) only ever translates text that appears here, so
 * nothing a person writes — messages, names, bios, channel names — can be translated or sent to the
 * translation engine: none of it is in the source. Output: apps/backend/i18n/ui-strings.json
 *   { strings: [...exact texts], templates: [...texts with {0} {1} for the ${} parts] }
 *
 * Run by deploy.sh before the images build; also `node scripts/extract-ui-strings.mjs` by hand.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const require = createRequire(path.join(root, "apps/frontend/package.json"));
const ts = require("typescript");

const SRC = path.join(root, "apps/frontend/src");
const OUT = path.join(root, "apps/backend/i18n/ui-strings.json");
// The owner console and developer portal stay in English: staff tools, not the product.
const SKIP_DIRS = new Set(["owner", "devportal"]);
// JSX attributes whose value a person reads or hears.
const TEXT_ATTRS = new Set(["placeholder", "title", "aria-label", "alt", "label", "description", "hint", "text", "heading", "message", "subtitle", "confirmLabel", "cancelLabel", "emptyText", "tooltip"]);
// Calls whose string arguments are never shown (class names, keys, logs, routes).
const SKIP_CALLS = /^(cn|clsx|console\.\w+|require|import|localStorage\.\w+|sessionStorage\.\w+|\w*[Ss]torage\.\w+|api\.\w+|fetch|navigate|new URL|new URLSearchParams|querySelector\w*|\w+\.querySelector\w*|addEventListener|removeEventListener|\w+\.addEventListener|\w+\.removeEventListener|matchMedia|window\.matchMedia|setAttribute|\w+\.setAttribute|getAttribute|\w+\.getAttribute|\w+\.startsWith|\w+\.endsWith|\w+\.includes|\w+\.split|\w+\.replace|\w+\.join|\w+\.emit|\w+\.on|\w+\.off|socket\.\w+|\w+\.get|\w+\.set|\w+\.has|\w+\.delete|useQuery|useMutation|queryKey|\w+\.invalidateQueries)$/;

function files(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) out.push(...files(path.join(dir, e.name)));
    } else if (/\.(tsx|ts)$/.test(e.name) && !/\.(test|spec)\.tsx?$/.test(e.name) && !e.name.endsWith(".d.ts")) {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

const tidy = (s) => s.replace(/\s+/g, " ").trim();

/** Words a person reads, as opposed to class names, keys, paths, CSS or code. */
function looksHuman(s) {
  if (s.length < 2 || s.length > 500) return false;
  if (!/\p{L}{2}/u.test(s)) return false;
  if (/^(https?:|mailto:|www\.|\/|\.\/|#[0-9a-f]{3,8}$|data:|blob:)/i.test(s)) return false;
  if (/[{};<>]|=>|\$\{|\\n/.test(s) && !/[.!?]$/.test(s)) return false;
  const tokens = s.split(" ");
  // Tailwind and other class lists: tokens with a colon, bracket, slash or a dash between lowercase parts.
  const classy = tokens.filter((t) => /[:[\]]|^-|^[a-z0-9]+(-[a-z0-9./%]+)+$|^[a-z]+\/[0-9]+$/.test(t)).length;
  if (classy >= Math.max(1, tokens.length / 2)) return false;
  // One lowercase token with no spaces: an identifier, an event name, a key.
  if (tokens.length === 1 && /^[a-z0-9_.\-]+$/.test(s)) return false;
  if (tokens.length === 1 && /^[A-Z0-9_]+$/.test(s) && s.length > 3) return false; // ENUM_VALUE
  if (/^[a-z]+([A-Z][a-z0-9]*)+$/.test(s)) return false; // camelCase
  if (/^[\w-]+\.(png|jpe?g|webp|svg|mp3|ogg|wav|json|js|css|html)$/i.test(s)) return false;
  return true;
}

const strings = new Set();
const templates = new Set();

function calleeName(expr) {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return `${calleeName(expr.expression)}.${expr.name.text}`;
  return "";
}

function insideSkippedCall(node) {
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isCallExpression(p) || ts.isNewExpression(p)) {
      const name = (ts.isNewExpression(p) ? "new " : "") + calleeName(p.expression);
      if (SKIP_CALLS.test(name) || SKIP_CALLS.test(name.split(".").slice(-2).join("."))) return true;
      return false;
    }
    if (ts.isJsxAttribute(p)) return !TEXT_ATTRS.has(p.name.getText()) && p.name.getText() !== "children";
    if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p)) return true;
    if (ts.isElementAccessExpression(p)) return true;
    if (ts.isCaseClause(p) || ts.isBinaryExpression(p) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(p.operatorToken.kind)) return true;
    if (ts.isTypeNode(p) || ts.isLiteralTypeNode(p)) return true;
    if (ts.isBlock(p) || ts.isSourceFile(p)) return false;
  }
  return false;
}

function addString(raw, jsxText = false) {
  const s = tidy(raw);
  // JSX text is always shown, so a lone lowercase word there ("members", "or") is real interface
  // text; the same word as a string literal is far more likely a key.
  if (jsxText ? s.length <= 500 && /\p{L}{2}/u.test(s) && !/[{};<>]/.test(s) : looksHuman(s)) strings.add(s);
}

for (const file of files(SRC)) {
  const text = fs.readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const visit = (node) => {
    if (ts.isJsxText(node)) {
      addString(node.text, true);
    } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (!ts.isPropertyAssignment(node.parent) || node.parent.initializer === node) {
        if (!insideSkippedCall(node)) addString(node.text);
      }
    } else if (ts.isTemplateExpression(node)) {
      if (!insideSkippedCall(node)) {
        let t = node.head.text;
        node.templateSpans.forEach((span, i) => { t += `{${i}}` + span.literal.text; });
        const s = tidy(t);
        const literal = s.replace(/\{\d+\}/g, "");
        if (looksHuman(literal.trim() || "x") && /\p{L}{2}/u.test(literal) && s.length <= 500) templates.add(s);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

// A template that is only placeholders and punctuation says nothing to translate.
const out = {
  generatedAt: new Date().toISOString(),
  strings: [...strings].sort(),
  templates: [...templates].filter((t) => /\p{L}{2}/u.test(t.replace(/\{\d+\}/g, ""))).sort(),
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 0) + "\n");
console.log(`ui-strings: ${out.strings.length} strings, ${out.templates.length} templates -> ${path.relative(root, OUT)}`);
