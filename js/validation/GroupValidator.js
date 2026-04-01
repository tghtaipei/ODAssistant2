/**
 * @fileoverview Validator that checks whether legislator-to-group associations
 * stated in the document match the data held in the DataRepository.
 *
 * Detection heuristic: for every `<文字>` element collect all `第N組` mentions
 * and all `姓名議員` mentions.  Any legislator name that appears in the same
 * text node as a group number is treated as an (legislator, group) pair.  The
 * pair is validated against {@link DataRepository#getLegislatorGroup}.
 */

import { ValidatorBase } from './ValidatorBase.js';

/**
 * Matches `第` followed by one or more ASCII digits followed by `組`.
 * Capture group 1 = the digit string (e.g. `"3"`).
 * The `g` flag is used with `matchAll`.
 */
const GROUP_RE = /第(\d+)組/g;

/**
 * Matches one or more CJK Unified Ideographs followed by `議員`.
 * Capture group 1 = the name characters.
 * The `g` flag is used with `matchAll`.
 */
const LEGISLATOR_RE = /([\u4e00-\u9fff]+)議員/g;

/**
 * Validator that verifies (legislator, group) pairs found in `<文字>` elements
 * against the group roster held in {@link DataRepository}.
 *
 * @extends {ValidatorBase}
 */
export class GroupValidator extends ValidatorBase {
  constructor() {
    super('GroupValidator');
  }

  /**
   * For each `<文字>` element that contains both a group reference (`第N組`) and a
   * legislator name reference (`姓名議員`), verify that the DataRepository agrees
   * the legislator belongs to that group.
   *
   * @param {Document}         xmlDoc    - The parsed DI document DOM.
   * @param {import('../DataRepository.js').DataRepository} dataRepo - Application data repository.
   * @returns {Promise<import('./ValidatorBase.js').ValidationResult[]>}
   */
  async validate(xmlDoc, dataRepo) {
    /** @type {import('./ValidatorBase.js').ValidationResult[]} */
    const results = [];

    // Track (name, mentioned-group) pairs already reported to avoid duplicates.
    /** @type {Set<string>} */
    const reported = new Set();

    const textElements = xmlDoc.getElementsByTagName('文字');

    for (const el of textElements) {
      const text = el.textContent ?? '';

      // Collect all group numbers mentioned in this text node.
      /** @type {string[]} */
      const mentionedGroups = [];
      for (const m of text.matchAll(GROUP_RE)) {
        mentionedGroups.push(m[1]); // digit string, e.g. "3"
      }

      if (mentionedGroups.length === 0) continue;

      // Collect all legislator names mentioned in this text node.
      /** @type {string[]} */
      const mentionedNames = [];
      for (const m of text.matchAll(LEGISLATOR_RE)) {
        mentionedNames.push(m[1]);
      }

      if (mentionedNames.length === 0) continue;

      // Cross-check every (name, group) combination present in the same text node.
      for (const name of mentionedNames) {
        for (const groupDigits of mentionedGroups) {
          const mentionedGroup = `第${groupDigits}組`;
          const pairKey = `${name}::${mentionedGroup}`;
          if (reported.has(pairKey)) continue;
          reported.add(pairKey);

          const actualGroup = dataRepo.getLegislatorGroup(name);

          // Only flag a mismatch when we actually know the legislator's group.
          // (Unknown legislators are handled by LegislatorValidator.)
          if (actualGroup !== null && actualGroup !== mentionedGroup) {
            results.push({
              field: '組別',
              message: `「${name}議員」的組別為「${actualGroup}」，與文件中的「${mentionedGroup}」不符，請確認。`,
            });
          }
        }
      }
    }

    return results;
  }
}
