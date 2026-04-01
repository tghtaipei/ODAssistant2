/**
 * @fileoverview Parser and serializer for DI files.
 *
 * DI is an XML-based government document format used by Taiwan government agencies.
 * The format includes a custom DOCTYPE declaration referencing an external DTD that
 * browsers cannot load, so we strip it before parsing and restore it on serialization.
 */

/**
 * @typedef {Object} ParsedDI
 * @property {string}   xmlDecl  - The XML declaration line, e.g. `<?xml version="1.0" encoding="utf-8"?>`.
 * @property {string}   doctype  - The DOCTYPE declaration string (everything from `<!DOCTYPE` to `]>`).
 * @property {Document} xmlDoc   - The parsed DOM document (without the DOCTYPE node).
 */

/**
 * Regex that captures the XML declaration at the start of a DI file.
 * Group 1 = full `<?xml … ?>` string.
 */
const XML_DECL_RE = /^(<\?xml[^?]*\?>)/;

/**
 * Regex that captures the DOCTYPE declaration.
 * DI doctypes span from `<!DOCTYPE` up to and including the closing `]>`.
 * Group 1 = full DOCTYPE string.
 */
const DOCTYPE_RE = /(<!DOCTYPE[\s\S]*?\]>)/;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a DI file string into its component parts.
 *
 * The browser's DOMParser cannot load external DTDs, so this function strips
 * the DOCTYPE before parsing and returns it separately so it can be restored
 * by {@link serialize}.
 *
 * @param {string} diContent - Raw DI file content (UTF-8 string).
 * @returns {ParsedDI} Parsed components.
 * @throws {Error} If the XML body is malformed or DOMParser reports a parse error.
 */
export function parse(diContent) {
  if (typeof diContent !== 'string' || diContent.length === 0) {
    throw new Error('DIParser.parse: diContent must be a non-empty string.');
  }

  // --- 1. Extract XML declaration -----------------------------------------
  const xmlDeclMatch = diContent.match(XML_DECL_RE);
  const xmlDecl = xmlDeclMatch ? xmlDeclMatch[1] : '<?xml version="1.0" encoding="utf-8"?>';

  // --- 2. Extract DOCTYPE --------------------------------------------------
  const doctypeMatch = diContent.match(DOCTYPE_RE);
  const doctype = doctypeMatch ? doctypeMatch[1] : '';

  // --- 3. Strip declaration + DOCTYPE so DOMParser can handle the markup ---
  let xmlBody = diContent;
  if (xmlDeclMatch) {
    xmlBody = xmlBody.replace(XML_DECL_RE, '');
  }
  if (doctypeMatch) {
    xmlBody = xmlBody.replace(DOCTYPE_RE, '');
  }
  xmlBody = xmlBody.trimStart();

  // --- 4. Parse with DOMParser ---------------------------------------------
  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(xmlBody, 'application/xml');

  // DOMParser signals errors by inserting a <parsererror> element.
  const parseError = xmlDoc.querySelector('parsererror');
  if (parseError) {
    const detail = parseError.textContent ?? 'unknown parse error';
    throw new Error(`DIParser.parse: XML parse failed — ${detail.trim()}`);
  }

  return { xmlDecl, doctype, xmlDoc };
}

/**
 * Serialize a parsed DI document back into a DI file string.
 *
 * Reassembles the original header (XML declaration + DOCTYPE) in front of the
 * serialized XML body produced by {@link XMLSerializer}.
 *
 * @param {Document} xmlDoc  - The DOM document to serialize.
 * @param {string}   xmlDecl - The XML declaration string.
 * @param {string}   doctype - The DOCTYPE declaration string.
 * @returns {string} Complete DI file content.
 */
export function serialize(xmlDoc, xmlDecl, doctype) {
  const serializer = new XMLSerializer();
  let body = serializer.serializeToString(xmlDoc);

  // XMLSerializer may prepend its own XML declaration; remove it so we can
  // prepend the original one unmodified.
  body = body.replace(/^<\?xml[^?]*\?>\s*/, '');

  const parts = [];
  if (xmlDecl) parts.push(xmlDecl);
  if (doctype) parts.push(doctype);
  parts.push(body);

  return parts.join('');
}

/**
 * Navigate a chain of tag names from the document root and return the trimmed
 * text content of the deepest matching element.
 *
 * Only the *first* matching child element is followed at each step, which
 * mirrors the single-document semantics of DI files.
 *
 * @param {Document} xmlDoc   - The parsed DOM document.
 * @param {string[]} tagPath  - Ordered list of tag names to traverse, e.g. `['函', '主旨', '文字']`.
 * @returns {string} The trimmed text content, or an empty string if the path
 *   does not resolve to an element.
 */
export function getTextContent(xmlDoc, tagPath) {
  if (!tagPath || tagPath.length === 0) return '';

  let node = /** @type {Element | Document} */ (xmlDoc);

  for (const tag of tagPath) {
    const child = node instanceof Document
      ? node.documentElement.tagName === tag
        ? node.documentElement
        : node.documentElement.getElementsByTagName(tag)[0]
      : /** @type {Element} */ (node).getElementsByTagName(tag)[0];

    if (!child) return '';
    node = child;
  }

  return (/** @type {Element} */ (node).textContent ?? '').trim();
}

/**
 * Navigate a chain of tag names from the document root and set the text
 * content of the deepest matching element.
 *
 * If the path does not resolve to an element the function is a no-op.
 *
 * @param {Document} xmlDoc    - The parsed DOM document (mutated in place).
 * @param {string[]} tagPath   - Ordered list of tag names to traverse.
 * @param {string}   value     - The text value to write.
 * @returns {void}
 */
export function setTextContent(xmlDoc, tagPath, value) {
  if (!tagPath || tagPath.length === 0) return;

  let node = /** @type {Element | Document} */ (xmlDoc);

  for (const tag of tagPath) {
    const child = node instanceof Document
      ? node.documentElement.tagName === tag
        ? node.documentElement
        : node.documentElement.getElementsByTagName(tag)[0]
      : /** @type {Element} */ (node).getElementsByTagName(tag)[0];

    if (!child) return;
    node = child;
  }

  /** @type {Element} */ (node).textContent = value;
}
