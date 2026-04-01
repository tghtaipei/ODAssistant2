/**
 * @fileoverview Handles validation and export of DI files.
 * Orchestrates the validation → warning-review → download flow.
 */

/**
 * @typedef {Object} ValidationResult
 * @property {'error'|'warning'|'info'} level
 * @property {string} message
 * @property {string} [field]
 */

/**
 * @typedef {Object} ExportPrep
 * @property {ValidationResult[]} warnings  - All non-blocking validation results.
 * @property {Function}           proceed   - Call this to trigger the actual download.
 */

export class ExportService {
  /**
   * @param {import('./validation/ValidationEngine.js').ValidationEngine} validationEngine
   * @param {import('./DIParser.js').DIParser}                            diParser
   */
  constructor(validationEngine, diParser) {
    /** @private */
    this._validationEngine = validationEngine;

    /** @private */
    this._diParser = diParser;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Run validation and prepare the export.
   *
   * The caller is responsible for showing the warnings UI and then invoking
   * `proceed()` if the user confirms.
   *
   * @param {Document} xmlDoc    - The live XML document from the editor.
   * @param {string}   doctype   - DOCTYPE declaration string (may be empty).
   * @param {string}   xmlDecl   - XML declaration string (e.g. `<?xml version="1.0"?>`).
   * @param {string}   caseType  - Case type code, e.g. "8-1".
   * @param {string}   filename  - Target download filename (without path).
   * @returns {Promise<ExportPrep>}
   */
  async prepareExport(xmlDoc, doctype, xmlDecl, caseType, filename) {
    // Run all registered validators.
    let results = [];
    try {
      results = await this._validationEngine.validate(xmlDoc, caseType);
    } catch (err) {
      console.error('[ExportService] 驗證失敗：', err);
      results = [{
        level: 'error',
        message: `驗證過程發生錯誤：${err.message}`,
      }];
    }

    // Separate hard errors from warnings/info.
    const errors   = results.filter((r) => r.level === 'error');
    const warnings = results.filter((r) => r.level !== 'error');

    // Hard errors block export entirely; surface them as "warnings" so the
    // UI can display them — the proceed function will be a no-op that explains
    // the situation.
    if (errors.length > 0) {
      return {
        warnings: results, // include errors in the display list
        proceed: () => {
          console.warn('[ExportService] 因驗證錯誤取消匯出');
        },
      };
    }

    // Build the proceed function (closure captures everything needed).
    const proceed = () => {
      this.doExport(xmlDoc, doctype, xmlDecl, filename);
    };

    return { warnings, proceed };
  }

  /**
   * Serialise the XML document and trigger a browser file download.
   *
   * @param {Document} xmlDoc   - The XML document to serialise.
   * @param {string}   doctype  - DOCTYPE string to inject after the XML declaration.
   * @param {string}   xmlDecl  - XML declaration (e.g. `<?xml version="1.0" encoding="UTF-8"?>`).
   * @param {string}   filename - Download filename.
   */
  doExport(xmlDoc, doctype, xmlDecl, filename) {
    // Serialise the document.
    const serialiser = new XMLSerializer();
    let xmlString = serialiser.serializeToString(xmlDoc);

    // XMLSerializer may prepend its own <?xml?> declaration.  Strip it so we
    // can inject our own (or none).
    xmlString = xmlString.replace(/^<\?xml[^?]*\?>\s*/i, '');

    // Build final output.
    const parts = [];
    if (xmlDecl) parts.push(xmlDecl);
    if (doctype)  parts.push(doctype);
    parts.push(xmlString);
    const output = parts.join('\n');

    // Create a Blob and trigger download.
    const blob = new Blob([output], { type: 'application/xml;charset=utf-8' });
    const url  = URL.createObjectURL(blob);

    const anchor = document.createElement('a');
    anchor.href     = url;
    anchor.download = filename || 'document.di';
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();

    // Clean up.
    setTimeout(() => {
      document.body.removeChild(anchor);
      URL.revokeObjectURL(url);
    }, 1000);
  }
}
