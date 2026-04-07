/**
 * @fileoverview 驗證文件中提到的議員姓名與組別是否相符。
 *
 * ─── 演算法說明 ──────────────────────────────────────────────
 *
 * 對每個包含「第N組」和「議員」關鍵字的文字節點：
 *   1. 找出所有「議員」出現位置，用與 LegislatorValidator 相同的方式
 *      擷取前方最多 N 個中文字（N = 名冊最長姓名字數），
 *      再從名冊中找出命中的議員姓名。
 *   2. 找出同一文字節點中所有「第X組」出現的組別。
 *   3. 對每個（議員姓名, 組別）組合，查詢 DataRepository 確認是否相符。
 *      - 相符 → 通過 ✓
 *      - 不符 → 告警（顯示實際組別）✗
 *      - 議員不在名冊 → 由 LegislatorValidator 負責，此處略過。
 *
 * ─────────────────────────────────────────────────────────────
 */

import { ValidatorBase } from './ValidatorBase.js';

/** 要掃描的 XML 標籤範圍。 */
const SCAN_TAGS = ['主旨', '段落', '副本'];

/** 匹配「第N組」，捕捉組別數字。 */
const GROUP_RE = /第(\d+)組/g;

/**
 * 從文字字串的指定位置往前，擷取最多 n 個「連續中文字」。
 * （與 LegislatorValidator 中的同名函式邏輯完全相同）
 *
 * @param {string} text
 * @param {number} position  - 「議員」的起始索引。
 * @param {number} n         - 擷取上限（= 名冊最長姓名字數）。
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
 * 驗證器：確認文件中（議員姓名, 組別）的對應關係正確。
 *
 * @extends {ValidatorBase}
 */
export class GroupValidator extends ValidatorBase {
  constructor() {
    super('GroupValidator');
  }

  /**
   * @param {Document} xmlDoc
   * @param {import('../DataRepository.js').DataRepository} dataRepo
   * @returns {Promise<import('./ValidatorBase.js').ValidationResult[]>}
   */
  async validate(xmlDoc, dataRepo) {
    /** @type {import('./ValidatorBase.js').ValidationResult[]} */
    const results = [];

    const legislators = dataRepo.getAllLegislators();

    // 尚未載入議員名冊時，略過此驗證
    if (legislators.length === 0) return results;

    // 名冊最長姓名字數，用於限制往前擷取範圍
    const maxNameLen = Math.max(...legislators.map(n => n.length));

    // 避免重複回報同一（姓名, 組別）組合
    const reported = new Set();

    for (const tag of SCAN_TAGS) {
      const elements = xmlDoc.getElementsByTagName(tag);

      for (const el of elements) {
        const text = el.textContent ?? '';

        // ── 步驟 1：收集此文字節點中所有提到的組別 ──
        /** @type {string[]} */
        const mentionedGroups = [];
        for (const m of text.matchAll(GROUP_RE)) {
          mentionedGroups.push(m[1]); // 僅保存數字字串，例如 "3"
        }

        // 若此節點沒有組別提及，跳過
        if (mentionedGroups.length === 0) continue;

        // ── 步驟 2：收集此文字節點中所有可辨識的議員姓名 ──
        /** @type {string[]} */
        const foundNames = [];
        let searchFrom = 0;

        while (true) {
          const idx = text.indexOf('議員', searchFrom);
          if (idx === -1) break;

          // 往前取最多 maxNameLen 個中文字
          const preceding = getCJKBefore(text, idx, maxNameLen);

          if (preceding.length > 0) {
            // 在名冊中找出命中的姓名（取最長命中以避免子字串誤判）
            const matched = legislators
              .filter(name => preceding.includes(name))
              .sort((a, b) => b.length - a.length)[0]; // 取最長命中

            if (matched && !foundNames.includes(matched)) {
              foundNames.push(matched);
            }
          }

          searchFrom = idx + 2;
        }

        // 若沒有識別出任何議員姓名，跳過（由 LegislatorValidator 負責）
        if (foundNames.length === 0) continue;

        // ── 步驟 3：交叉比對（議員姓名, 組別）─────────
        for (const name of foundNames) {
          for (const groupDigits of mentionedGroups) {
            const mentionedGroup = `第${groupDigits}組`;
            const pairKey = `${name}::${mentionedGroup}`;

            if (reported.has(pairKey)) continue;
            reported.add(pairKey);

            const actualGroup = dataRepo.getLegislatorGroup(name);

            // 只在確實知道該議員組別時才比對（未知議員由 LegislatorValidator 處理）
            if (actualGroup !== null && actualGroup !== mentionedGroup) {
              results.push({
                field: '組別',
                message: `「${name}議員」的組別為「${actualGroup}」，與文件中的「${mentionedGroup}」不符，請確認。`,
              });
            }
          }
        }
      }
    }

    return results;
  }
}
