/**
 * @fileoverview 儲存草稿時自動更新副本受文者。
 *
 * ─── 流程說明 ──────────────────────────────────────────────────
 *
 * 1. 從主旨擷取議員姓名（使用議員名冊）。
 *
 * 2. 從主旨擷取組別（如「第1組」）。
 *    ‣ 若無組別但有議員姓名 → 直接以該議員更新副本第一位（Rule 4），流程結束。
 *
 * 3. （有組別時）偵測會議/部門類型：
 *    - 優先：主旨直接包含 CSV 類型名稱（如「警政衛生部門」）。
 *    - 備援：主旨含 SUBJECT_KEYWORD_MAP 別名（如「定期大會」→「市政總質詢」）。
 *
 * 4. 驗證：主旨議員的實際組別與主旨標示的組別一致。
 *    若不一致 → 回傳 failed 結果，不修改 XML。
 *
 * 5. 取得該組別的所有議員，從 <副本> 中移除所有
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
  // ── 前置條件：議員名冊必須已載入 ──────────────────────────────
  const legislators = dataRepo.getAllLegislators();
  if (legislators.length === 0) {
    return { skipped: true, reason: '議員名冊未載入，副本未自動更新' };
  }

  const subjectEl   = xmlDoc.getElementsByTagName('主旨')[0];
  const subjectText = subjectEl ? (subjectEl.textContent ?? '') : '';

  // ── 步驟 1：從主旨擷取議員姓名 ───────────────────────────────
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

  // ── 步驟 2：從主旨取得組別 ────────────────────────────────────
  const groupMatch = GROUP_RE.exec(subjectText);

  // 【Rule 4】無組別但有議員姓名 → 只新增該議員一人至副本第一位
  // 此規則在無法判斷會議類型時仍需執行，因此優先於會議類型偵測。
  if (!groupMatch) {
    if (!subjectLegislator) {
      return { skipped: true, reason: '主旨中未找到組別或議員姓名，副本未自動更新' };
    }
    return _fillSingleLegislator(xmlDoc, subjectLegislator, legislators);
  }

  // ── 步驟 3：有組別時才需要取得會議類型 ────────────────────────
  const meetingTypes = dataRepo.getAllMeetingTypes();
  if (meetingTypes.length === 0) {
    return { skipped: true, reason: '組別資料未載入，副本未自動更新' };
  }

  const meetingType = detectMeetingType(subjectText, meetingTypes);
  if (!meetingType) {
    return { skipped: true, reason: '無法從主旨判斷會議/部門類型，副本未自動更新' };
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
 * 移除「未確認」（佔位符）的議員型 <全銜>，保留已確認姓名（存在於名冊）的議員受文者，
 * 並將主旨議員置於第一位。
 *
 * @param {Document}  xmlDoc
 * @param {string}    subjectLegislator - 議員姓名（來自主旨）。
 * @param {string[]}  legislators       - 完整議員名冊。
 * @returns {AutoFillResult}
 */
function _fillSingleLegislator(xmlDoc, subjectLegislator, legislators) {
  const fubenEl = xmlDoc.getElementsByTagName('副本')[0];
  if (!fubenEl) {
    return { skipped: true, reason: '文件中未找到 <副本> 區塊，副本未自動更新' };
  }

  /**
   * 從 <全銜> 的直接文字中擷取純議員姓名。
   * 例如「臺北市議會李傅中武議員」→「李傅中武」。
   * @param {Element} el
   * @returns {string|null}
   */
  function extractName(el) {
    const text = getDirectText(el).trim();
    if (!text.startsWith(RECIP_PREFIX)) return null;
    const after = text.slice(RECIP_PREFIX.length);
    const suffixIdx = after.lastIndexOf(RECIP_SUFFIX);
    if (suffixIdx === -1) return null;
    return after.slice(0, suffixIdx) || null;
  }

  const allQuanXian = Array.from(fubenEl.getElementsByTagName('全銜'));
  const legislatorEls    = allQuanXian.filter(el => isLegislatorRecipient(el));
  const nonLegislatorEls = allQuanXian.filter(el => !isLegislatorRecipient(el));

  // 已確認的「其他」議員：名冊中有此姓名，且不是主旨中的議員
  const confirmedOtherEls = legislatorEls.filter(el => {
    const name = extractName(el);
    return name && legislators.includes(name) && name !== subjectLegislator;
  });
  // 未確認（佔位符或不在名冊）的議員元素直接捨棄

  // 移除所有 <全銜>（之後依序重建）
  allQuanXian.forEach(el => fubenEl.removeChild(el));

  // 順序：① 主旨議員　② 已確認的其他議員　③ 非議員受文者
  fubenEl.appendChild(createLegislatorElement(xmlDoc, subjectLegislator));
  for (const el of confirmedOtherEls) fubenEl.appendChild(el);
  for (const el of nonLegislatorEls)  fubenEl.appendChild(el);

  return {
    skipped:    false,
    failed:     false,
    reason:     `已自動更新副本：僅新增「${subjectLegislator}議員」至第一位`,
    addedCount: 1,
  };
}

// ─── 等議員提案：以指定名單填入主旨佔位符與副本受文者 ─────────────

/**
 * 主旨含「等議員提案」時，以使用者輸入的名單一次性更新：
 * 1. 將主旨 <文字> 中「等議員提案」前方的佔位符（○、〇）替換為第一位議員姓名。
 * 2. 移除 <副本> 內所有議員型 <全銜>，依名單順序重新新增。
 *
 * @param {Document} xmlDoc
 * @param {string[]} names  - 議員姓名清單（純姓名，不含「議員」前後綴）。
 * @returns {{ ok: boolean, reason: string }}
 */
export function fillProposers(xmlDoc, names) {
  // ── 1. 更新主旨 ────────────────────────────────────────────────
  const subjectEl = xmlDoc.getElementsByTagName('主旨')[0];
  const wenziEl   = subjectEl?.getElementsByTagName('文字')[0];
  if (wenziEl) {
    // 匹配「等議員提案」前方連續的 ○ 或 〇 佔位符
    // 同時支援「○○○等議員提案」和「○○○議員等議員提案」兩種格式
    const PLACEHOLDER_RE = /[○〇]+(?=(?:議員)?等議員提案)/;
    wenziEl.textContent = (wenziEl.textContent ?? '').replace(PLACEHOLDER_RE, names[0]);
  }

  // ── 2. 更新副本 ────────────────────────────────────────────────
  const fubenEl = xmlDoc.getElementsByTagName('副本')[0];
  if (!fubenEl) {
    return { ok: false, reason: '文件中未找到 <副本> 區塊' };
  }

  // 保留非議員受文者
  const nonLegislatorChildren = Array.from(fubenEl.childNodes).filter(
    child =>
      child.nodeType === Node.ELEMENT_NODE &&
      /** @type {Element} */ (child).tagName === '全銜' &&
      !isLegislatorRecipient(/** @type {Element} */ (child))
  );

  // 移除所有 <全銜>
  Array.from(fubenEl.getElementsByTagName('全銜'))
    .forEach(el => fubenEl.removeChild(el));

  // 依名單順序新增議員
  for (const name of names) {
    fubenEl.appendChild(createLegislatorElement(xmlDoc, name));
  }

  // 非議員受文者附加至最後
  for (const child of nonLegislatorChildren) {
    fubenEl.appendChild(child);
  }

  return {
    ok:     true,
    reason: `已填入 ${names.length} 位提案議員，副本已更新`,
  };
}
