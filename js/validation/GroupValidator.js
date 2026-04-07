/**
 * @fileoverview 驗證文件中議員組別是否與名冊相符。
 *
 * ─── 演算法說明 ──────────────────────────────────────────────
 *
 * 由於每位議員在「定期大會」和「部門質詢」的組別可能不同，
 * 必須先確認文件屬於哪種會議類型，才能比對正確的組別。
 *
 * 完整流程：
 *
 * 1. 從 DataRepository 取得所有已載入的會議/部門類型
 *    （即 CSV 第一欄的所有不重複值，例如「定期大會」、「警政衛生部門」）。
 *
 * 2. 掃描文件的 <主旨> 全文，確認包含哪些會議類型關鍵字：
 *    - 若主旨包含其中一個已知的會議類型字串 → 鎖定該 meetingType。
 *    - 若找到多個或完全找不到 → 無法判斷類型，跳過組別驗證（避免誤報）。
 *
 * 3. 在掃描範圍（主旨、說明、副本）中找出所有「議員」出現位置，
 *    用與 LegislatorValidator 相同的方式：
 *    - 往前取最多 maxNameLen 個連續中文字。
 *    - 從名冊中找出命中的議員姓名（取最長命中，避免短名字誤判）。
 *
 * 4. 取得該議員在偵測到的 meetingType 下的組別（`getLegislatorGroupByType`）。
 *
 * 5. 在同一 XML 元素內掃描所有「第N組」提及，
 *    若與查出的組別不符 → 跳出告警。
 *
 * 範例：
 *   主旨：「…定期大會…劉耀仁議員…」
 *   偵測到 meetingType = '定期大會'
 *   劉耀仁在「定期大會」的組別 = 第3組
 *   文件中提到「第1組」→ 不符 → 警告 ✗
 *
 *   主旨：「…警政衛生部門…劉耀仁議員…」
 *   偵測到 meetingType = '警政衛生部門'
 *   劉耀仁在「警政衛生部門」的組別 = 第1組
 *   文件中提到「第1組」→ 相符 → 通過 ✓
 * ─────────────────────────────────────────────────────────────
 */

import { ValidatorBase } from './ValidatorBase.js';

/** 要掃描議員與組別的 XML 標籤範圍。 */
const SCAN_TAGS = ['主旨', '段落', '副本'];

/** 匹配「第N組」，捕捉組別數字。 */
const GROUP_RE = /第(\d+)組/g;

/**
 * 從文字字串的指定位置往前，擷取最多 n 個「連續中文字」。
 * 遇到非 CJK 字元即停止。（與 LegislatorValidator 中相同的工具函式）
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
    // CJK Unified Ideographs: U+4E00 ~ U+9FFF
    if (code >= 0x4e00 && code <= 0x9fff) {
      result = text[i] + result;
    } else {
      break;
    }
  }
  return result;
}

/**
 * 驗證器：依據文件主旨判斷會議類型，再比對議員組別是否正確。
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
    if (legislators.length === 0) return results;

    const meetingTypes = dataRepo.getAllMeetingTypes();
    if (meetingTypes.length === 0) return results;

    const maxNameLen = Math.max(...legislators.map(n => n.length));

    // ── 步驟 1：從主旨偵測會議/部門類型 ─────────────────────────
    // 取主旨的全文（textContent 涵蓋所有子元素）
    const subjectEl = xmlDoc.getElementsByTagName('主旨')[0];
    const subjectText = subjectEl ? (subjectEl.textContent ?? '') : '';

    // 找出主旨中命中的所有已知會議類型
    const matched = meetingTypes.filter(type => subjectText.includes(type));

    if (matched.length !== 1) {
      // 找到 0 個或 2 個以上，無法確定類型，跳過驗證避免誤報
      return results;
    }

    const meetingType = matched[0]; // 確定唯一的會議類型

    // ── 步驟 2：掃描各欄位，找出（議員姓名, 提及組別）對 ────────
    // 用 Set 避免重複回報相同的（姓名, 組別）組合
    const reported = new Set();

    for (const tag of SCAN_TAGS) {
      const elements = xmlDoc.getElementsByTagName(tag);

      for (const el of elements) {
        const text = el.textContent ?? '';

        // ── 2a. 收集此節點中所有提及的組別 ──
        /** @type {string[]} */
        const mentionedGroups = [];
        for (const m of text.matchAll(GROUP_RE)) {
          mentionedGroups.push(m[1]); // 組別數字字串，例如 "1"
        }
        if (mentionedGroups.length === 0) continue;

        // ── 2b. 識別此節點中所有議員姓名 ──
        /** @type {string[]} */
        const foundNames = [];
        let searchFrom = 0;

        while (true) {
          const idx = text.indexOf('議員', searchFrom);
          if (idx === -1) break;

          const preceding = getCJKBefore(text, idx, maxNameLen);

          if (preceding.length > 0) {
            // 取最長命中的議員姓名，避免短名字（子字串）誤判
            const name = legislators
              .filter(n => preceding.includes(n))
              .sort((a, b) => b.length - a.length)[0];

            if (name && !foundNames.includes(name)) {
              foundNames.push(name);
            }
          }

          searchFrom = idx + 2;
        }

        if (foundNames.length === 0) continue;

        // ── 2c. 交叉比對（議員, 組別）────────────────────────────
        for (const name of foundNames) {
          for (const groupDigits of mentionedGroups) {
            const mentionedGroup = `第${groupDigits}組`;
            const pairKey = `${name}::${mentionedGroup}::${meetingType}`;

            if (reported.has(pairKey)) continue;
            reported.add(pairKey);

            // 查詢該議員在此會議類型下的實際組別
            const actualGroup = dataRepo.getLegislatorGroupByType(name, meetingType);

            if (actualGroup === null) {
              // 此議員在該會議類型下查無組別（可能 CSV 未包含此類型的資料），跳過
              continue;
            }

            if (actualGroup !== mentionedGroup) {
              results.push({
                field: '組別',
                message: `「${name}議員」在「${meetingType}」的組別為「${actualGroup}」，文件中寫的「${mentionedGroup}」不符，請確認。`,
              });
            }
          }
        }
      }
    }

    return results;
  }
}
