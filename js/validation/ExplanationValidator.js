/**
 * @fileoverview 驗證說明第一項（一、）的日期佔位符與議員姓名。
 *
 * 規則 1（日期佔位符）：
 *   說明第一項的文字中，若「年」、「月」或「日」前方仍有 2 個以上的「0」
 *   （例如「000年」、「00月」、「00日」），視為尚未填寫日期，發出警告。
 *
 * 規則 2（議員姓名一致性）：
 *   若主旨中偵測到有效議員姓名，則掃描說明所有條列項目；
 *   若任何條列項目中出現「議員」關鍵字且對應的議員姓名與主旨不符，發出警告。
 *   使用與 LegislatorValidator / GroupValidator 相同的 getCJKBefore 演算法（N = 最長姓名字數）。
 */

import { ValidatorBase } from './ValidatorBase.js';

/** 日期佔位符的正規表達式：2 個以上的 0 緊接著「年」、「月」或「日」。 */
const ZERO_DATE_RE = /0{2,}[年月日]/;

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
 * 驗證器：說明第一項的日期佔位符與議員姓名一致性。
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

    // 找出 段名 含「說明」的 <段落> 元素
    const paragraphs = xmlDoc.getElementsByTagName('段落');
    let duanEl = null;
    for (let i = 0; i < paragraphs.length; i++) {
      if ((paragraphs[i].getAttribute('段名') ?? '').includes('說明')) {
        duanEl = paragraphs[i];
        break;
      }
    }
    // fallback：若找不到帶屬性的 <段落>，取第一個 <段落>
    if (!duanEl && paragraphs.length > 0) duanEl = paragraphs[0];
    if (!duanEl) return results;

    const allItems = Array.from(duanEl.getElementsByTagName('條列'));
    if (allItems.length === 0) return results;

    const firstItemText = allItems[0].textContent ?? '';

    // ── 規則 1：說明第一項的日期佔位符 ──────────────────────────
    if (ZERO_DATE_RE.test(firstItemText)) {
      results.push({
        field:   '說明',
        message: '說明第一項的日期仍有未填寫的佔位符（如「00年」、「00月」、「00日」），請確認是否匯出！',
      });
    }

    // ── 規則 2：說明各項目的議員姓名與主旨一致性 ─────────────────
    // 前置條件：議員名冊已載入
    const legislators = dataRepo.getAllLegislators();
    if (legislators.length === 0) return results;

    const maxNameLen = Math.max(...legislators.map(n => n.length));

    const subjectEl   = xmlDoc.getElementsByTagName('主旨')[0];
    const subjectText = subjectEl ? (subjectEl.textContent ?? '') : '';

    // 主旨中必須有「合法」議員姓名（findLegislatorInText 只回傳名冊中存在的姓名）
    const subjectLegislator = findLegislatorInText(subjectText, legislators, maxNameLen);
    if (!subjectLegislator) return results;  // 主旨無有效議員姓名，不檢查說明

    // 掃描所有 <條列> 項目，找出包含「議員」關鍵字且姓名與主旨不符的項目
    const warned = new Set();  // 避免相同問題重複回報

    for (const item of allItems) {
      const itemText = item.textContent ?? '';
      if (!itemText.includes('議員')) continue;  // 無「議員」關鍵字，跳過

      const itemLegislator = findLegislatorInText(itemText, legislators, maxNameLen);

      // 有效姓名但與主旨不一致 → 告警
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

