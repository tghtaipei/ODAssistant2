/**
 * @fileoverview 儲存草稿時自動更新副本受文者。
 *
 * ─── 流程說明 ──────────────────────────────────────────────────
 *
 * 1. 從主旨偵測會議/部門類型（同 GroupValidator 邏輯）：
 *    - 優先：主旨直接包含 CSV 類型名稱（如「警政衛生部門」）。
 *    - 備援：主旨含 SUBJECT_KEYWORD_MAP 別名（如「定期大會」→「市政總質詢」）。
 *
 * 2. 從主旨擷取組別（如「第1組」）。
 *
 * 3. 驗證：找出主旨中「議員」前方的議員姓名，確認其組別與主旨一致。
 *    若不一致 → 回傳 failed 結果，不修改 XML，並告知使用者。
 *
 * 4. 取得該組別的所有議員，從 <副本> 中移除所有
 *    「臺北市議會...議員」型態的 <全銜> 元素，再逐一新增各議員的 <全銜>。
 *
 * 新增的 <全銜> 格式：
 *   <全銜 發文方式="紙本">臺北市議會XXX議員
 *     <傳送方式>紙本</傳送方式>
 *     <郵遞區號></郵遞區號>
 *     <地址></地址>
 *     <通訊錄名稱 機關代碼="" 單位代碼="">臺北市議會XXX議員</通訊錄名稱>
 *     <含附件>N</含附件>
 *   </全銜>
 * ─────────────────────────────────────────────────────────────
 */

/**
 * 主旨關鍵字 → CSV 類型名稱 的別名對應表。
 * 與 GroupValidator 保持一致：當主旨使用的詞彙和 CSV 第一欄不同時，在此設定對應。
 * @type {Record<string, string>}
 */
const SUBJECT_KEYWORD_MAP = {
  '定期大會': '市政總質詢',
};

/** 識別「議員受文者」的前綴與後綴。 */
const RECIP_PREFIX = '臺北市議會';
const RECIP_SUFFIX = '議員';

/** 從主旨擷取組別（第N組）。 */
const GROUP_RE = /第(\d+)組/;

// ─── 內部工具函式 ──────────────────────────────────────────────

/**
 * 從文字字串的指定位置往前，擷取最多 n 個「連續中文字」。
 * 遇到非 CJK 字元（U+4E00–U+9FFF 以外）即停止。
 *
 * @param {string} text
 * @param {number} position - 搜尋起始位置（即「議員」的索引），往前讀取。
 * @param {number} n        - 最多擷取字數。
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
 * 取得 XML 元素的「直接文字節點」內容（不含子元素的文字）。
 * 即 <全銜> 開頭標籤後、第一個子元素前的純文字。
 *
 * @param {Element} el
 * @returns {string}
 */
function getDirectText(el) {
  for (const child of el.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) return child.nodeValue ?? '';
  }
  return '';
}

/**
 * 判斷 <全銜> 是否為「議員受文者」型態（臺北市議會...議員）。
 *
 * @param {Element} el
 * @returns {boolean}
 */
function isLegislatorRecipient(el) {
  const text = getDirectText(el).trim();
  return text.startsWith(RECIP_PREFIX) && text.includes(RECIP_SUFFIX);
}

/**
 * 從 meetingTypes 清單中，依主旨文字決定應使用的 CSV 類型。
 *
 * @param {string}   subjectText
 * @param {string[]} meetingTypes
 * @returns {string|null}
 */
function detectMeetingType(subjectText, meetingTypes) {
  // 第一優先：主旨直接包含 CSV 類型名稱
  const direct = meetingTypes.filter(t => subjectText.includes(t));
  if (direct.length === 1) return direct[0];
  if (direct.length > 1)   return null; // 多重命中，無法判斷

  // 第二優先：別名對應
  for (const [keyword, csvType] of Object.entries(SUBJECT_KEYWORD_MAP)) {
    if (subjectText.includes(keyword) && meetingTypes.includes(csvType)) {
      return csvType;
    }
  }
  return null;
}

/**
 * 為指定議員建立符合 DI 格式的 <全銜> XML 元素。
 *
 * @param {Document} xmlDoc
 * @param {string}   name  - 議員姓名（不含「臺北市議會」前綴與「議員」後綴）。
 * @returns {Element}
 */
function createLegislatorElement(xmlDoc, name) {
  const fullName = `${RECIP_PREFIX}${name}${RECIP_SUFFIX}`;

  const quanXian = xmlDoc.createElement('全銜');
  quanXian.setAttribute('發文方式', '紙本');
  // 直接文字節點（在所有子元素之前）
  quanXian.appendChild(xmlDoc.createTextNode(fullName));

  const send = xmlDoc.createElement('傳送方式');
  send.textContent = '紙本';
  quanXian.appendChild(send);

  quanXian.appendChild(xmlDoc.createElement('郵遞區號'));
  quanXian.appendChild(xmlDoc.createElement('地址'));

  const contact = xmlDoc.createElement('通訊錄名稱');
  contact.setAttribute('機關代碼', '');
  contact.setAttribute('單位代碼', '');
  contact.textContent = fullName;
  quanXian.appendChild(contact);

  const attach = xmlDoc.createElement('含附件');
  attach.textContent = 'N';
  quanXian.appendChild(attach);

  return quanXian;
}

// ─── 主要函式 ──────────────────────────────────────────────────

/**
 * @typedef {Object} AutoFillResult
 * @property {boolean}       skipped    - 因資料不足或無法判斷而跳過（無錯誤，XML 未修改）。
 * @property {boolean}       [failed]   - 驗證失敗（組別不符），XML 未修改。
 * @property {string}        reason     - 說明訊息。
 * @property {string}        [meetingType]
 * @property {string}        [groupLabel]
 * @property {number}        [addedCount] - 實際新增的議員人數。
 */

/**
 * 自動更新 <副本> 中的議員受文者。
 *
 * 呼叫時機：使用者按下「儲存草稿」前。
 * 此函式直接修改傳入的 xmlDoc（in-place）。
 *
 * @param {Document}                                            xmlDoc
 * @param {import('./DataRepository.js').DataRepository}       dataRepo
 * @returns {AutoFillResult}
 */
export function autoFillRecipients(xmlDoc, dataRepo) {
  // ── 前置條件：議員名冊與組別資料必須已載入 ──────────────────
  const legislators = dataRepo.getAllLegislators();
  if (legislators.length === 0) {
    return { skipped: true, reason: '議員名冊未載入，副本未自動更新' };
  }

  const meetingTypes = dataRepo.getAllMeetingTypes();
  if (meetingTypes.length === 0) {
    return { skipped: true, reason: '組別資料未載入，副本未自動更新' };
  }

  // ── 步驟 1：從主旨取得會議類型 ────────────────────────────────
  const subjectEl  = xmlDoc.getElementsByTagName('主旨')[0];
  const subjectText = subjectEl ? (subjectEl.textContent ?? '') : '';

  const meetingType = detectMeetingType(subjectText, meetingTypes);
  if (!meetingType) {
    return { skipped: true, reason: '無法從主旨判斷會議/部門類型，副本未自動更新' };
  }

  // ── 步驟 2：從主旨擷取議員姓名 ───────────────────────────────
  const maxNameLen = Math.max(...legislators.map(n => n.length));
  let subjectLegislator = null;
  let searchFrom = 0;

  while (true) {
    const idx = subjectText.indexOf('議員', searchFrom);
    if (idx === -1) break;
    const preceding = getCJKBefore(subjectText, idx, maxNameLen);
    const found = legislators
      .filter(n => preceding.includes(n))
      .sort((a, b) => b.length - a.length)[0];
    if (found) { subjectLegislator = found; break; }
    searchFrom = idx + 2;
  }

  // ── 步驟 3：從主旨取得組別 ────────────────────────────────────
  const groupMatch = GROUP_RE.exec(subjectText);

  // 【Rule 4】無組別但有議員姓名 → 只新增該議員一人至副本第一位
  if (!groupMatch) {
    if (!subjectLegislator) {
      return { skipped: true, reason: '主旨中未找到組別或議員姓名，副本未自動更新' };
    }
    return _fillSingleLegislator(xmlDoc, subjectLegislator);
  }

  const groupLabel = `第${groupMatch[1]}組`;

  // ── 步驟 4：驗證主旨中的議員姓名與組別是否一致 ───────────────
  if (subjectLegislator) {
    const actualGroup = dataRepo.getLegislatorGroupByType(subjectLegislator, meetingType);
    if (actualGroup && actualGroup !== groupLabel) {
      return {
        skipped: false,
        failed:  true,
        reason:  `「${subjectLegislator}議員」的實際組別為「${actualGroup}」，與主旨中的「${groupLabel}」不符，請先修正主旨再儲存`,
        meetingType,
        groupLabel,
      };
    }
  }

  // ── 步驟 5：取得該組別所有議員 ────────────────────────────────
  const groupMembers = dataRepo.getLegislatorsByGroup(meetingType, groupLabel);
  if (groupMembers.length === 0) {
    return {
      skipped: true,
      reason:  `找不到 ${meetingType} ${groupLabel} 的議員資料，副本未自動更新`,
    };
  }

  // ── 步驟 6：更新 <副本> XML ────────────────────────────────────
  // 順序：① 主旨中提到的議員　② 同組其他議員　③ 原範本內非議員受文者
  const fubenEl = xmlDoc.getElementsByTagName('副本')[0];
  if (!fubenEl) {
    return { skipped: true, reason: '文件中未找到 <副本> 區塊，副本未自動更新' };
  }

  // 先收集非議員受文者（保留，稍後附加至最末）
  const nonLegislatorChildren = Array.from(fubenEl.childNodes).filter(
    child =>
      child.nodeType === Node.ELEMENT_NODE &&
      /** @type {Element} */ (child).tagName === '全銜' &&
      !isLegislatorRecipient(/** @type {Element} */ (child))
  );

  // 移除所有 <全銜>（議員 + 非議員皆移除，之後依序重建）
  Array.from(fubenEl.childNodes)
    .filter(child => child.nodeType === Node.ELEMENT_NODE && /** @type {Element} */ (child).tagName === '全銜')
    .forEach(child => fubenEl.removeChild(child));

  // 排序議員：主旨提到的議員優先放第一位，其餘依 CSV 順序
  const orderedMembers = subjectLegislator && groupMembers.includes(subjectLegislator)
    ? [subjectLegislator, ...groupMembers.filter(n => n !== subjectLegislator)]
    : groupMembers;

  // ① ② 新增議員 <全銜>
  for (const name of orderedMembers) {
    fubenEl.appendChild(createLegislatorElement(xmlDoc, name));
  }

  // ③ 非議員受文者附加至最後
  for (const child of nonLegislatorChildren) {
    fubenEl.appendChild(child);
  }

  return {
    skipped:     false,
    failed:      false,
    reason:      `已自動更新副本：${meetingType} ${groupLabel}，共 ${groupMembers.length} 位議員`,
    meetingType,
    groupLabel,
    addedCount:  groupMembers.length,
  };
}

// ─── 內部輔助：單一議員模式（無組別）────────────────────────────

/**
 * 主旨中只有議員姓名、沒有組別時，只將該議員新增至副本第一位。
 * 移除所有現有的議員型 <全銜>，保留非議員受文者。
 *
 * @param {Document} xmlDoc
 * @param {string}   name  - 議員姓名。
 * @returns {AutoFillResult}
 */
function _fillSingleLegislator(xmlDoc, name) {
  const fubenEl = xmlDoc.getElementsByTagName('副本')[0];
  if (!fubenEl) {
    return { skipped: true, reason: '文件中未找到 <副本> 區塊，副本未自動更新' };
  }

  // 保留非議員受文者
  const nonLegislatorChildren = Array.from(fubenEl.childNodes).filter(
    child =>
      child.nodeType === Node.ELEMENT_NODE &&
      /** @type {Element} */ (child).tagName === '全銜' &&
      !isLegislatorRecipient(/** @type {Element} */ (child))
  );

  // 移除所有 <全銜>
  Array.from(fubenEl.childNodes)
    .filter(child => child.nodeType === Node.ELEMENT_NODE && /** @type {Element} */ (child).tagName === '全銜')
    .forEach(child => fubenEl.removeChild(child));

  // 新增議員至第一位，再附加非議員受文者
  fubenEl.appendChild(createLegislatorElement(xmlDoc, name));
  for (const child of nonLegislatorChildren) {
    fubenEl.appendChild(child);
  }

  return {
    skipped:    false,
    failed:     false,
    reason:     `已自動更新副本：僅新增「${name}議員」至第一位`,
    addedCount: 1,
  };
}
