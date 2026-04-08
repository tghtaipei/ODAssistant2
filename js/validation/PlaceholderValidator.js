/**
 * @fileoverview Validator that warns when unreplaced placeholder characters
 * (○) remain in the document's editable text fields.
 *
 * Scans 主旨, 說明, 副本 for any occurrence of ○ and produces a warning,
 * since templates use ○ as a fill-in marker that must be replaced before export.
 */

import { ValidatorBase } from './ValidatorBase.js';

/**
 * Tags to scan for placeholder characters.
 * Covers the sections visible in the editor.
 */
const SCAN_TAGS = ['主旨', '段落', '副本'];

export class PlaceholderValidator extends ValidatorBase {
  constructor() {
    super('PlaceholderValidator');
  }

  /**
   * @param {Document} xmlDoc
   * @param {import('../DataRepository.js').DataRepository} _dataRepo
   * @returns {Promise<import('./ValidatorBase.js').ValidationResult[]>}
   */
  async validate(xmlDoc, _dataRepo) {
    /** @type {import('./ValidatorBase.js').ValidationResult[]} */
    const results = [];

    for (const tag of SCAN_TAGS) {
      const els = xmlDoc.getElementsByTagName(tag);
      for (const el of els) {
        if ((el.textContent ?? '').includes('○')) {
          const label = tag === '段落' ? '說明' : tag;
          results.push({
            field: label,
            message: `「${label}」欄位仍有未填寫的佔位符「○」，請確認是否匯出！`,
          });
          break; // 同一個 tag 只報一次
        }
      }
    }

    // 檢查主旨是否含有「00」數字佔位符（如「第00次」、「第00組」）
    const subjectEls = xmlDoc.getElementsByTagName('主旨');
    for (const el of subjectEls) {
      if (/00/.test(el.textContent ?? '')) {
        results.push({
          field: '主旨',
          message: '主旨仍有未填寫的數字佔位符「00」（如「第00次」、「第00組」），請確認是否匯出！',
        });
        break;
      }
    }

    return results;
  }
}
