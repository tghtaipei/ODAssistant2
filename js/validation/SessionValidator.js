/**
 * @fileoverview 驗證會期設定是否符合公文主旨，以及會期名單是否仍在有效期間內。
 *
 * 資料來源：議員分組.csv 第一列的會期中繼資料
 *   格式：屆期,會期,起始日期(YYYYMMDD),結束日期(YYYYMMDD),議長,副議長
 *   範例：14,07,20260428,20260616,戴錫欽,葉林傳
 *
 * 規則 1（名單有效期）：
 *   若儲存 / 匯出當天日期超過結束日期 60 天以上，發出警告，
 *   提醒使用者確認名單是否需要更新。
 *
 * 規則 2（主旨屆次一致性）：
 *   若主旨含「第XX屆第XX次定期大會」，比對其屆期與會期數字是否與
 *   CSV 中繼資料一致；若不一致，發出警告提醒更新名單。
 */

import { ValidatorBase } from './ValidatorBase.js';

/** 超過結束日期幾天後發出警告。 */
const EXPIRE_WARN_DAYS = 60;

/**
 * 將 YYYYMMDD 字串解析為當天結束時刻（23:59:59）的 Date 物件。
 *
 * @param {string} str
 * @returns {Date|null}
 */
function parseDateStr(str) {
  if (!str || str.length !== 8) return null;
  const year  = parseInt(str.slice(0, 4), 10);
  const month = parseInt(str.slice(4, 6), 10) - 1; // 0-indexed
  const day   = parseInt(str.slice(6, 8), 10);
  if (isNaN(year) || isNaN(month) || isNaN(day)) return null;
  return new Date(year, month, day, 23, 59, 59);
}

/**
 * 驗證器：會期有效期與屆次一致性。
 *
 * @extends {ValidatorBase}
 */
export class SessionValidator extends ValidatorBase {
  constructor() {
    super('SessionValidator');
  }

  /**
   * @param {Document} xmlDoc
   * @param {import('../DataRepository.js').DataRepository} dataRepo
   * @returns {Promise<import('./ValidatorBase.js').ValidationResult[]>}
   */
  async validate(xmlDoc, dataRepo) {
    /** @type {import('./ValidatorBase.js').ValidationResult[]} */
    const results = [];

    const meta = dataRepo.getSessionMeta();
    if (!meta) return results; // 無中繼資料，略過所有檢核

    // ── 規則 1：名單有效期檢查 ────────────────────────────────────
    const endDate = parseDateStr(meta.endDate);
    if (endDate) {
      const today   = new Date();
      const diffMs  = today.getTime() - endDate.getTime();
      const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
      if (diffDays > EXPIRE_WARN_DAYS) {
        results.push({
          field:   '會期',
          message: `已超過該會期結束日期逾 ${EXPIRE_WARN_DAYS} 天，請確認會期及議員分組名單是否正確！`,
        });
      }
    }

    // ── 規則 2：主旨屆次與名單一致性 ─────────────────────────────
    const subjectEl   = xmlDoc.getElementsByTagName('主旨')[0];
    const subjectText = subjectEl ? (subjectEl.textContent ?? '') : '';

    // 匹配「第XX屆第XX次定期大會」，捕捉屆期與會期數字
    const sessionMatch = /第(\d+)屆第(\d+)次定期大會/.exec(subjectText);
    if (sessionMatch) {
      const subjectTerm    = parseInt(sessionMatch[1], 10);
      const subjectSession = parseInt(sessionMatch[2], 10);
      const metaTerm       = parseInt(meta.term,    10);
      const metaSession    = parseInt(meta.session, 10);

      if (subjectTerm !== metaTerm || subjectSession !== metaSession) {
        results.push({
          field:   '會期',
          message: `主旨的屆次（第 ${subjectTerm} 屆第 ${subjectSession} 次）與議員分組名單（第 ${metaTerm} 屆第 ${metaSession} 次）不符，請企劃科更新新會期議員分組名單！`,
        });
      }
    }

    return results;
  }
}
