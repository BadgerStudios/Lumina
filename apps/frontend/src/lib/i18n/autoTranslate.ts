/**
 * Translates the interface in place, in the DOM, from a language pack.
 *
 * Every text node and every readable attribute (placeholder, title, aria-label, alt) is looked up
 * in the pack — an exact entry first, then the templates for text built from ${} parts. The pack
 * holds only the app's own text (see scripts/extract-ui-strings.mjs), so what people write never
 * matches and is never touched: nothing is sent anywhere to be translated, it is all local.
 *
 * Safe alongside React because it only ever rewrites a node's own text (`Text.data`) or an
 * attribute, never adds or removes nodes; React keeps the same node and simply writes over it when
 * the English changes, which the observer sees and translates again. The English of every node
 * touched is remembered, so switching language or back to English restores it exactly.
 */

export interface LanguagePack {
  lang: string;
  version: string;
  complete: boolean;
  strings: Record<string, string>;
  templates: Record<string, string>;
}

interface Template {
  re: RegExp;
  /** Placeholder numbers in the order they appear in the English, i.e. the regex group order. */
  order: number[];
  translated: string;
  /** The longest fixed piece of the English, for a cheap `includes` before trying the regex. */
  anchor: string;
}

interface Shown {
  english: string;
  shown: string;
}

const ATTRS = ["placeholder", "title", "aria-label", "alt"] as const;
const SKIP = '[translate="no"],script,style,code,pre,textarea,[contenteditable=""],[contenteditable="true"],.notranslate';
const MEMO_LIMIT = 5000;

let strings = new Map<string, string>();
let templates: Template[] = [];
let active = false;
const memo = new Map<string, string | null>();
const texts = new WeakMap<Text, Shown>();
const attrs = new WeakMap<Element, Map<string, Shown>>();
let observer: MutationObserver | null = null;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compileTemplate(english: string, translated: string): Template | null {
  const order: number[] = [];
  const pieces = english.split(/\{(\d)\}/);
  let source = "^";
  let anchor = "";
  pieces.forEach((piece, i) => {
    if (i % 2 === 1) {
      order.push(Number(piece));
      source += "(.+?)";
    } else {
      source += escapeRe(piece);
      if (piece.trim().length > anchor.length) anchor = piece.trim();
    }
  });
  if (order.length === 0 || anchor.length < 2) return null;
  return { re: new RegExp(source + "$", "s"), order, translated, anchor };
}

function translateCore(core: string): string | null {
  const exact = strings.get(core);
  if (exact !== undefined) return exact;
  const known = memo.get(core);
  if (known !== undefined) return known;
  let out: string | null = null;
  for (const t of templates) {
    if (!core.includes(t.anchor)) continue;
    const m = t.re.exec(core);
    if (!m) continue;
    out = t.translated.replace(/\{(\d)\}/g, (_, n: string) => m[t.order.indexOf(Number(n)) + 1] ?? "");
    break;
  }
  if (memo.size >= MEMO_LIMIT) memo.clear();
  memo.set(core, out);
  return out;
}

/** The translation of `s` with its own surrounding whitespace, or null when the pack has none. */
export function translateText(s: string): string | null {
  if (!active) return null;
  const core = s.replace(/\s+/g, " ").trim();
  if (core.length < 2 || core.length > 500 || !/\p{L}/u.test(core)) return null;
  const t = translateCore(core);
  if (t === null) return null;
  return (/^\s*/.exec(s)?.[0] ?? "") + t + (/\s*$/.exec(s)?.[0] ?? "");
}

function skipped(el: Element | null): boolean {
  return !el || el.closest(SKIP) !== null;
}

function onText(node: Text): void {
  const seen = texts.get(node);
  if (seen && node.data === seen.shown) return; // our own write, or unchanged
  if (seen) texts.delete(node);
  if (!active || skipped(node.parentElement)) return;
  const english = node.data;
  const t = translateText(english);
  if (t === null || t === english) return;
  texts.set(node, { english, shown: t });
  node.data = t;
}

function onAttr(el: Element, name: string): void {
  const value = el.getAttribute(name);
  let map = attrs.get(el);
  const seen = map?.get(name);
  if (seen && value === seen.shown) return;
  if (seen) map!.delete(name);
  if (!active || value === null || skipped(el)) return;
  const t = translateText(value);
  if (t === null || t === value) return;
  if (!map) attrs.set(el, (map = new Map()));
  map.set(name, { english: value, shown: t });
  el.setAttribute(name, t);
}

function scan(root: Node): void {
  if (root.nodeType === Node.TEXT_NODE) {
    onText(root as Text);
    return;
  }
  if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return;
  if (root.nodeType === Node.ELEMENT_NODE) {
    const el = root as Element;
    for (const a of ATTRS) if (el.hasAttribute(a)) onAttr(el, a);
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeType === Node.TEXT_NODE) onText(n as Text);
    else for (const a of ATTRS) if ((n as Element).hasAttribute(a)) onAttr(n as Element, a);
  }
}

/** Puts back the English everywhere this module changed it. */
function restoreAll(): void {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeType === Node.TEXT_NODE) {
      const seen = texts.get(n as Text);
      if (seen) {
        texts.delete(n as Text);
        if ((n as Text).data === seen.shown) (n as Text).data = seen.english;
      }
    } else {
      const map = attrs.get(n as Element);
      if (!map) continue;
      for (const [name, seen] of map) if ((n as Element).getAttribute(name) === seen.shown) (n as Element).setAttribute(name, seen.english);
      attrs.delete(n as Element);
    }
  }
}

function ensureObserver(): void {
  if (observer || typeof MutationObserver === "undefined") return;
  observer = new MutationObserver((records) => {
    if (!active) return;
    for (const r of records) {
      if (r.type === "characterData") onText(r.target as Text);
      else if (r.type === "attributes") onAttr(r.target as Element, r.attributeName!);
      else r.addedNodes.forEach(scan);
    }
  });
  observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: [...ATTRS] });
}

/** Switches the interface to `pack` (or back to English with null). Idempotent. */
export function showPack(pack: LanguagePack | null): void {
  if (typeof document === "undefined" || !document.body) return;
  if (active) restoreAll();
  memo.clear();
  if (!pack || pack.lang === "en") {
    active = false;
    strings = new Map();
    templates = [];
    return;
  }
  strings = new Map(Object.entries(pack.strings));
  templates = Object.entries(pack.templates)
    .map(([en, tr]) => compileTemplate(en, tr))
    .filter((t): t is Template => t !== null)
    // Longest first, so "{0} and {1} are typing…" is tried before a looser "{0} are typing…".
    .sort((a, b) => b.re.source.length - a.re.source.length);
  active = true;
  ensureObserver();
  scan(document.body);
}
