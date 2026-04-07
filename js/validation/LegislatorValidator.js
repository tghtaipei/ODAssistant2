/**
 * @fileoverview 驗證文件中提到的議員姓名是否存在於議員名冊。
 *
 * ─── 演算法說明 ──────────────────────────────────────────────
 *
 * 舊做法的問題：
 *   用 regex /([\u4e00-\u9fff]+)議員/g 會貪婪擷取「議員」前方所有連續中文字，
 *   導致「第1組劉耀仁議員」被擷取為「組劉耀仁」而非「劉耀仁」。
 *
 * 新做法：
 *   1. 掃描 主旨、說明（段落）、副本 等欄位中所有「議員」關鍵字出現位置。
 *   2. 從議員名冊取得最長姓名的字數（例如「李傅中武」= 4 字），作為擷取上限。
 *   3. 對每個「議員」往前取最多 N 個「連續中文字」（遇到非中文字元即停止）。
 *   4. 檢查名冊中是否有任何一位議員姓名，是那 N 個字的子字串。
 *      - 有找到 → 通過驗證。
 *      - 找不到 → 可能誤植，匯出前跳出告警。
 *
 * 範例（maxNameLen = 4）：
 *   「臺北市議會劉耀仁議員」→ 往前取 4 字：「會劉耀仁」
 *     → 名冊中「劉耀仁」是其子字串 → 通過 ✓
 *
 *   「臺北市議會劉耀人議員」（誤植「仁」為「人」）→ 取 4 字：「會劉耀人」
 *     → 無任何議員姓名命中 → 警告 ✗
 *
 *   「第1組劉耀仁議員」→ 遇到「1」（非中文）停止，只取「組劉耀仁」
 *     → 名冊中「劉耀仁」是其子字串 → 通過 ✓
 * ─────────────────────────────────────────────────────────────
 */

import { ValidatorBase } from './ValidatorBase.js';

/** 要掃描的 XML 標籤範圍（涵蓋編輯器中可見的三個區塊）。 */
const SCAN_TAGS = ['主旨', '段落', '副本'];

/**
 * 從文字字串的指定位置往前，擷取最多 n 個「連續中文字」。
 * 遇到非 CJK 字元（數字、英文、標點等）立即停止。
 *
 * @param {string} text      - 要搜尋的完整文字。
 * @param {number} position  - 搜尋起始位置（即「議員」的索引），往前讀取。
 * @param {number} n         - 最多擷取的中文字數（= 名冊中最長姓名字數）。
 * @returns {string} 緊接在目標位置之前的連續中文字（最多 n 個），保持原始順序。
 */
function getCJKBefore(text, position, n) {
  let result = '';
  for (let i = position - 1; i >= 0 && result.length < n; i--) {
    const code = text.charCodeAt(i);
    // CJK Unified Ideographs: U+4E00 ~ U+9FFF
    if (code >= 0x4e00 && code <= 0x9fff) {
      result = text[i] + result; // 往前累加，維持原始順序
    } else {
      break; // 遇到非中文字元即停止
    }
  }
  return result;
}

/**
 * 驗證器：掃描文件中所有「議員」前方文字，確認包含名冊中的合法姓名。
 *
 * @extends {ValidatorBase}
 */
export class LegislatorValidator extends ValidatorBase {
  constructor() {
    super('LegislatorValidator');
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

    // 尚未載入議員名冊時，略過此驗證（避免誤報）
    if (legislators.length === 0) return results;

    // 取得名冊中最長姓名的字數，作為往前擷取的上限
    const maxNameLen = Math.max(...legislators.map(n => n.length));

    // 用 Set 記錄已回報的組合，避免同一問題重複出現
    const reported = new Set();

    for (const tag of SCAN_TAGS) {
      const elements = xmlDoc.getElementsByTagName(tag);

      for (const el of elements) {
        const text = el.textContent ?? '';
        let searchFrom = 0;

        while (true) {
          // 找下一個「議員」的位置
          const idx = text.indexOf('議員', searchFrom);
          if (idx === -1) break;

          // 往前擷取最多 maxNameLen 個連續中文字
          const preceding = getCJKBefore(text, idx, maxNameLen);

          if (preceding.length > 0) {
            const key = `${tag}::${preceding}議員`;

            if (!reported.has(key)) {
              // 檢查名冊中是否有任何議員姓名是 preceding 的子字串
              const matched = legislators.some(name => preceding.includes(name));

              if (!matched) {
                reported.add(key);
                results.push({
                  field: '議員名稱',
                  message: `「...${preceding}議員」中找不到已知議員姓名，請確認是否有誤植。`,
                });
              }
            }
          }

          searchFrom = idx + 2; // 跳過已處理的「議員」，繼續往後搜尋
        }
      }
    }

    return results;
  }
}
