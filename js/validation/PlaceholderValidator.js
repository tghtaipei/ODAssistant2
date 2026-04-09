/**
 * @fileoverview 檢核文件中仍有未填寫的佔位符。
 *
 * 規則 1（○ 佔位符）：
 *   掃描 主旨、說明（段落）、副本，若出現「○」字元，代表範本中的填寫欄位
 *   尚未填入，發出警告。
 *
 * 規則 2（「00」數字佔位符）：
 *   掃描 主旨 中是否含有「00」（如「第00次」、「第00組」）。
 *   掃描 說明第一項 中是否含有 2 個以上的 0 緊接著「年」「月」「日」
 *   （如「000年」「00月」「00日」），代表日期尚未填寫，發出警告。
 *   兩者同屬「數字佔位符」，整併為同一條規則處理。
 */

import { ValidatorBase } from './ValidatorBase.js';

/** 掃描「○」佔位符的 XML 標籤範圍。 */
const SCAN_TAGS = ['主旨', '段落', '副本'];

/** 日期欄位中「00年/月/日」的正規表達式。 */
const ZERO_DATE_RE = /0{2,}[年月日]/;

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

    // ── 規則 1：「○」佔位符 ─────────────────────────────────────
    for (const tag of SCAN_TAGS) {
      const els = xmlDoc.getElementsByTagName(tag);
      for (const el of els) {
        if ((el.textContent ?? '').includes('○')) {
          const label = tag === '段落' ? '說明' : tag;
          results.push({
            field:   label,
            message: `「${label}」欄位仍有未填寫的佔位符「○」，請確認是否匯出！`,
          });
          break; // 同一個 tag 只報一次
        }
      }
    }

    // ── 規則 2：「00」數字佔位符（主旨 + 說明第一項日期）─────────
    // 2a. 主旨：任意「00」組合
    const subjectEls = xmlDoc.getElementsByTagName('主旨');
    for (const el of subjectEls) {
      if (/00/.test(el.textContent ?? '')) {
        results.push({
          field:   '主旨',
          message: '主旨仍有未填寫的數字佔位符「00」（如「第00次」、「第00組」），請確認是否匯出！',
        });
        break;
      }
    }

    // 2b. 說明第一項：日期格式（00年 / 00月 / 00日）
    const paragraphs = xmlDoc.getElementsByTagName('段落');
    let duanEl = null;
    for (let i = 0; i < paragraphs.length; i++) {
      if ((paragraphs[i].getAttribute('段名') ?? '').includes('說明')) {
        duanEl = paragraphs[i];
        break;
      }
    }
    if (!duanEl && paragraphs.length > 0) duanEl = paragraphs[0];
    if (duanEl) {
      const firstItem = duanEl.getElementsByTagName('條列')[0];
      if (firstItem && ZERO_DATE_RE.test(firstItem.textContent ?? '')) {
        results.push({
          field:   '說明',
          message: '說明第一項的日期仍有未填寫的數字佔位符（如「000年」、「00月」、「00日」），請確認是否匯出！',
        });
      }
    }

    return results;
  }
}
