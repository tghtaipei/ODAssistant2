/**
 * @fileoverview 驗證說明欄位的議員姓名一致性。
 *
 * 規則（議員姓名一致性）：
 *   若主旨中偵測到有效議員姓名，則掃描說明所有條列項目；
 *   若任何條列項目中出現「議員」關鍵字且對應的議員姓名與主旨不符，發出警告。
 *   使用與 LegislatorValidator / GroupValidator 相同的 getCJKBefore 演算法
 *   （N = 名冊中最長姓名字數）。
 *
 * 注意：「00」數字佔位符的檢核已整併至 PlaceholderValidator，本檔不重複處理。
 */

import { ValidatorBase } from './ValidatorBase.js';

/**
 * 從文字字串的指定位置往前，擷取最多 n 個連續 CJK 字元。
 * 遇到非 CJK 字元即停止。
 *
 * @param {string} text
 * @param {number} position
 * @param {number} n
 * @returns {string}
 */
function getCJKBefore(text, position, n) {
  let result = '';
  for (let i = position - 1; i >= 0 && result.length < n; i--) {
    const code = text.charCodeAt(i);
    if (code >= 0x4e00 && code <= 0x9fff) {
      result = text[i] + result;
    } else {
      break;
    }
  }
  return result;
}

/**
 * 從文字中找出第一個符合名冊的議員姓名（取最長匹配，避免子字串誤判）。
 *
 * @param {string}   text
 * @param {string[]} legislators
 * @param {number}   maxNameLen
 * @returns {string|null}
 */
function findLegislatorInText(text, legislators, maxNameLen) {
  let searchFrom = 0;
  while (true) {
    const idx = text.indexOf('議員', searchFrom);
    if (idx === -1) break;
    const preceding = getCJKBefore(text, idx, maxNameLen);
    const found = legislators
      .filter(n => preceding.includes(n))
      .sort((a, b) => b.length - a.length)[0];
    if (found) return found;
    searchFrom = idx + 2;
  }
  return null;
}

/**
 * 驗證器：說明欄位的議員姓名與主旨一致性。
 *
 * @extends {ValidatorBase}
 */
export class ExplanationValidator extends ValidatorBase {
  constructor() {
    super('ExplanationValidator');
  }

  /**
   * @param {Document} xmlDoc
   * @param {import('../DataRepository.js').DataRepository} dataRepo
   * @returns {Promise<import('./ValidatorBase.js').ValidationResult[]>}
   */
  async validate(xmlDoc, dataRepo) {
    /** @type {import('./ValidatorBase.js').ValidationResult[]} */
    const results = [];

    // 前置條件：議員名冊已載入
    const legislators = dataRepo.getAllLegislators();
    if (legislators.length === 0) return results;

    const maxNameLen = Math.max(...legislators.map(n => n.length));

    const subjectEl   = xmlDoc.getElementsByTagName('主旨')[0];
    const subjectText = subjectEl ? (subjectEl.textContent ?? '') : '';

    // 主旨中必須有「合法」議員姓名，才有必要比對說明
    const subjectLegislator = findLegislatorInText(subjectText, legislators, maxNameLen);
    if (!subjectLegislator) return results;

    // 找出 段名 含「說明」的 <段落> 元素
    const paragraphs = xmlDoc.getElementsByTagName('段落');
    let duanEl = null;
    for (let i = 0; i < paragraphs.length; i++) {
      if ((paragraphs[i].getAttribute('段名') ?? '').includes('說明')) {
        duanEl = paragraphs[i];
        break;
      }
    }
    if (!duanEl && paragraphs.length > 0) duanEl = paragraphs[0];
    if (!duanEl) return results;

    const allItems = Array.from(duanEl.getElementsByTagName('條列'));
    if (allItems.length === 0) return results;

    // 掃描所有 <條列> 項目，找出包含「議員」關鍵字且姓名與主旨不符的項目
    const warned = new Set(); // 避免相同問題重複回報

    for (const item of allItems) {
      const itemText = item.textContent ?? '';
      if (!itemText.includes('議員')) continue;

      const itemLegislator = findLegislatorInText(itemText, legislators, maxNameLen);

      if (itemLegislator && itemLegislator !== subjectLegislator) {
        const key = `${subjectLegislator}≠${itemLegislator}`;
        if (!warned.has(key)) {
          warned.add(key);
          results.push({
            field:   '說明',
            message: `說明欄位的議員姓名「${itemLegislator}」與主旨中的「${subjectLegislator}」不符，請確認。`,
          });
        }
      }
    }

    return results;
  }
}
