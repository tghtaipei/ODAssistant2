/**
 * @fileoverview 驗證文件中議員組別是否與名冊相符。
 *
 * ─── 演算法說明 ──────────────────────────────────────────────
 *
 * 由於每位議員在「市政總質詢」和「部門質詢」的組別可能不同，
 * 必須先確認文件屬於哪種會議類型，才能比對正確的組別。
 *
 * 完整流程：
 *
 * 1. 從 DataRepository 取得所有已載入的會議/部門類型
 *    （即 CSV 第一欄的所有不重複值，例如「市政總質詢」、「警政衛生部門」）。
 *
 * 2. 掃描文件的 <主旨> 全文，確認包含哪些會議類型關鍵字：
 *    - 第一優先：主旨直接包含 CSV 類型字串 → 鎖定該 meetingType。
 *    - 第二優先：主旨不含 CSV 類型，但含有 SUBJECT_KEYWORD_MAP 中的別名關鍵字
 *                → 對應到指定的 CSV 類型（例如主旨說「定期大會」→ CSV 用「市政總質詢」）。
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
 *   主旨：「…定期大會市長施政報告…第1組劉耀仁議員…」
 *   「定期大會」→ 別名對應 CSV 類型「市政總質詢」
 *   劉耀仁在「市政總質詢」的組別 = 第3組
 *   文件中提到「第1組」→ 不符 → 警告 ✗
 *
 *   主旨：「…警政衛生部門質詢…第1組劉耀仁議員…」
 *   「警政衛生部門」直接命中 CSV 類型
 *   劉耀仁在「警政衛生部門」的組別 = 第1組
 *   文件中提到「第1組」→ 相符 → 通過 ✓
 * ─────────────────────────────────────────────────────────────
 */

import { ValidatorBase } from './ValidatorBase.js';

/** 要掃描議員與組別的 XML 標籤範圍。 */
const SCAN_TAGS = ['主旨', '段落', '副本'];

/**
 * 主旨關鍵字 → CSV 類型 的別名對應表。
 *
 * 當主旨中出現的關鍵字與 CSV 第一欄的類型名稱不一致時，
 * 可在此設定對應關係。例如：
 *   公文主旨說「定期大會」，但議員分組.csv 第一欄寫「市政總質詢」。
 *
 * 規則：key = 主旨中出現的字串，value = CSV 第一欄對應的類型名稱。
 *
 * @type {Record<string, string>}
 */
const SUBJECT_KEYWORD_MAP = {
  '定期大會': '市政總質詢',
};

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

    console.debug('[GroupValidator] 主旨文字：', subjectText);
    console.debug('[GroupValidator] 已知會議類型：', meetingTypes);

    // 第一優先：主旨直接包含 CSV 中的類型名稱
    const directMatched = meetingTypes.filter(type => subjectText.includes(type));
    console.debug('[GroupValidator] 直接命中的會議類型：', directMatched);

    /** @type {string|null} 最終確定的 CSV 類型 */
    let meetingType = null;

    if (directMatched.length === 1) {
      meetingType = directMatched[0];
    } else if (directMatched.length === 0) {
      // 第二優先：主旨未含 CSV 類型，嘗試 SUBJECT_KEYWORD_MAP 別名對應
      // 例如主旨說「定期大會」→ 對應 CSV 類型「市政總質詢」
      for (const [keyword, csvType] of Object.entries(SUBJECT_KEYWORD_MAP)) {
        if (subjectText.includes(keyword) && meetingTypes.includes(csvType)) {
          meetingType = csvType;
          console.debug(`[GroupValidator] 別名命中：主旨含「${keyword}」→ CSV 類型「${csvType}」`);
          break;
        }
      }

      if (!meetingType) {
        // 直接命中和別名對應均失敗，無法判斷會議類型，跳過以避免誤報
        console.debug('[GroupValidator] 無法判斷會議類型，跳過組別驗證');
        return results;
      }
    } else {
      // 命中多個 CSV 類型，無法確定，跳過
      console.warn('[GroupValidator] 命中多個類型，跳過：', directMatched);
      return results;
    }

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
              const notFoundKey = `${name}::notfound::${meetingType}`;
              if (!reported.has(notFoundKey)) {
                reported.add(notFoundKey);
                results.push({
                  field: '組別',
                  message: `「${name}議員」未出現在「${meetingType}」的分組名單中，請確認並更新「${meetingType}」分組名單！`,
                });
              }
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
