/**
 * @fileoverview Validator that checks whether legislator names mentioned in the
 * document exist in the DataRepository.
 *
 * Detection heuristic: scan every `<文字>` element for text matching one or more
 * Chinese characters immediately followed by `議員`.  Each extracted name is
 * looked up in the DataRepository; unknown names produce a warning.
 */

import { ValidatorBase } from './ValidatorBase.js';

/**
 * Matches one or more CJK Unified Ideographs (U+4E00–U+9FFF) immediately
 * followed by the literal string `議員`.
 *
 * Capture group 1 = the name characters before `議員`.
 *
 * The `g` flag is used with `String.prototype.matchAll` to find all occurrences
 * within a single text node.
 */
const LEGISLATOR_RE = /([\u4e00-\u9fff]+)議員/g;

/**
 * Validator that verifies every `姓名議員` reference in `<文字>` elements against
 * the legislator roster held in {@link DataRepository}.
 *
 * @extends {ValidatorBase}
 */
export class LegislatorValidator extends ValidatorBase {
  constructor() {
    super('LegislatorValidator');
  }

  /**
   * Scan all `<文字>` elements in the document for legislator name patterns and
   * report any names that are not present in the DataRepository.
   *
   * @param {Document}         xmlDoc    - The parsed DI document DOM.
   * @param {import('../DataRepository.js').DataRepository} dataRepo - Application data repository.
   * @returns {Promise<import('./ValidatorBase.js').ValidationResult[]>}
   */
  async validate(xmlDoc, dataRepo) {
    /** @type {import('./ValidatorBase.js').ValidationResult[]} */
    const results = [];

    // Collect all text nodes inside <文字> elements.
    const textElements = xmlDoc.getElementsByTagName('文字');

    // Track names already reported so we don't duplicate warnings.
    const reported = new Set();

    for (const el of textElements) {
      const text = el.textContent ?? '';
      for (const match of text.matchAll(LEGISLATOR_RE)) {
        const name = match[1];
        if (reported.has(name)) continue;
        reported.add(name);

        if (!dataRepo.hasLegislator(name)) {
          results.push({
            field: '議員名稱',
            message: `「${name}議員」不在議員名單中，請確認姓名是否正確。`,
          });
        }
      }
    }

    return results;
  }
}
