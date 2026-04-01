/**
 * @fileoverview Validator for case type "8-1 函復議會協調案件".
 *
 * All findings from this validator are non-blocking warnings intended to catch
 * common mistakes before a document is exported / transmitted.
 *
 * Checked fields:
 *   - 主旨  — template text integrity and placeholder removal
 *   - 說明  — 依據 sentence format and placeholder removal
 *   - 正本  — placeholder characters
 *   - 副本  — placeholder characters and forbidden recipients
 */

import { ValidatorBase } from './ValidatorBase.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Regex for the 說明 一、依據 sentence.
 *
 * Required format:
 *   一、依據臺北市議會{2-3 digit year}年{1-12月}{1-31日}議{anything}字第{digits}號書函辦理。
 */
const SHUO_MING_YI_JU_RE =
  /^一、依據臺北市議會\d{2,3}年(?:0?[1-9]|1[0-2])月(?:0?[1-9]|[12]\d|3[01])日議.+?字第\d+號書函辦理。$/;

/**
 * Text content that must NOT appear in the 副本 field.
 * These recipients should not be CC'd on 函復議會協調案件.
 */
const FORBIDDEN_CC_TERMS = ['本府研考會', '本府府會總聯絡人', '本局府會聯絡人'];

// ---------------------------------------------------------------------------
// Helper utilities
// ---------------------------------------------------------------------------

/**
 * Collect the combined text content of all descendant elements under a given
 * top-level tag name.
 *
 * @param {Document} xmlDoc
 * @param {string}   tagName - Tag to search at the document level.
 * @returns {string} Concatenated text of all descendants (not trimmed).
 */
function getAllTextUnder(xmlDoc, tagName) {
  const el = xmlDoc.getElementsByTagName(tagName)[0];
  return el ? (el.textContent ?? '') : '';
}

/**
 * Navigate to a `<條列>` element with a specific `序號` attribute inside a
 * `<段落>` element with a specific `段名` attribute, then return the text of
 * the first `<文字>` child.
 *
 * @param {Document} xmlDoc
 * @param {string}   duanName  - Value of the `段名` attribute on `<段落>`.
 * @param {string}   xuHao     - Value of the `序號` attribute on `<條列>`.
 * @returns {string} Trimmed text content, or empty string if not found.
 */
function getListItemText(xmlDoc, duanName, xuHao) {
  const paragraphs = xmlDoc.getElementsByTagName('段落');
  for (const para of paragraphs) {
    if (para.getAttribute('段名') !== duanName) continue;
    const lists = para.getElementsByTagName('條列');
    for (const list of lists) {
      if (list.getAttribute('序號') !== xuHao) continue;
      const wenZi = list.getElementsByTagName('文字')[0];
      return wenZi ? (wenZi.textContent ?? '').trim() : '';
    }
  }
  return '';
}

// ---------------------------------------------------------------------------
// Validator class
// ---------------------------------------------------------------------------

/**
 * Validates documents of case type "8-1 函復議會協調案件".
 *
 * @extends {ValidatorBase}
 */
export class CaseType81Validator extends ValidatorBase {
  constructor() {
    super('CaseType81Validator');
  }

  /**
   * Run all 8-1-specific validation rules against the document.
   *
   * @param {Document}         xmlDoc    - The parsed DI document DOM.
   * @param {import('../DataRepository.js').DataRepository} _dataRepo - Not used by this validator.
   * @returns {Promise<import('./ValidatorBase.js').ValidationResult[]>}
   */
  async validate(xmlDoc, _dataRepo) {
    /** @type {import('./ValidatorBase.js').ValidationResult[]} */
    const results = [];

    this._validateZhuZhi(xmlDoc, results);
    this._validateShuoMing(xmlDoc, results);
    this._validateZhengBen(xmlDoc, results);
    this._validateFuBen(xmlDoc, results);

    return results;
  }

  // -------------------------------------------------------------------------
  // Private field validators
  // -------------------------------------------------------------------------

  /**
   * Validate the 主旨 field.
   *
   * Expected template:
   *   `有關臺北市議會市民服務中心協調○○○陳情案，復如說明，請查照。`
   * where `○○○` is variable (replaced by the actual petitioner name).
   *
   * Rule 1: The fixed parts of the template must still be present.
   * Rule 2: No unreplaced `○` placeholder characters may remain.
   *
   * @param {Document} xmlDoc
   * @param {import('./ValidatorBase.js').ValidationResult[]} results
   */
  _validateZhuZhi(xmlDoc, results) {
    const zhuZhiEl = xmlDoc.getElementsByTagName('主旨')[0];
    if (!zhuZhiEl) return;

    const wenZi = zhuZhiEl.getElementsByTagName('文字')[0];
    const text = wenZi ? (wenZi.textContent ?? '').trim() : '';

    // Rule 1: Structural integrity check.
    // Split the template on the variable segment (○○○) and verify the fixed
    // prefix and suffix are present in the actual text.
    const PREFIX = '有關臺北市議會市民服務中心協調';
    const SUFFIX = '陳情案，復如說明，請查照。';

    const hasPrefix = text.startsWith(PREFIX);
    const hasSuffix = text.endsWith(SUFFIX);

    if (!hasPrefix || !hasSuffix) {
      results.push({
        field: '主旨',
        message: '主旨欄位已修改到不該修改之文字，請確認是否匯出!',
      });
    }

    // Rule 2: Unreplaced placeholder check.
    if (text.includes('○')) {
      results.push({
        field: '主旨',
        message: '主旨欄位資料包含有未修改字元「○」請確認是否匯出!',
      });
    }
  }

  /**
   * Validate the 說明 一、依據 sentence.
   *
   * Rule 1: Must match {@link SHUO_MING_YI_JU_RE}.
   * Rule 2: Must not contain `○`, `000`, or `00`.
   *
   * @param {Document} xmlDoc
   * @param {import('./ValidatorBase.js').ValidationResult[]} results
   */
  _validateShuoMing(xmlDoc, results) {
    const text = getListItemText(xmlDoc, '說明：', '一、');

    // Rule 1: Format check.
    if (!SHUO_MING_YI_JU_RE.test(text)) {
      results.push({
        field: '說明',
        message: '說明欄位之依據有誤，請確認是否匯出!',
      });
    }

    // Rule 2: Unreplaced placeholder check.
    if (text.includes('○') || text.includes('000') || text.includes('00')) {
      results.push({
        field: '說明',
        message: '說明欄位之「依據」包含有未修改字元請確認是否匯出!',
      });
    }
  }

  /**
   * Validate the 正本 field.
   *
   * Rule 1: No unreplaced `○` placeholder characters.
   *
   * @param {Document} xmlDoc
   * @param {import('./ValidatorBase.js').ValidationResult[]} results
   */
  _validateZhengBen(xmlDoc, results) {
    const text = getAllTextUnder(xmlDoc, '正本');

    if (text.includes('○')) {
      results.push({
        field: '正本',
        message: '正本欄位包含有未修改字元「○」請確認是否匯出!',
      });
    }
  }

  /**
   * Validate the 副本 field.
   *
   * Rule 1: No unreplaced `○` placeholder characters.
   * Rule 2: Must not contain forbidden recipient strings.
   *
   * @param {Document} xmlDoc
   * @param {import('./ValidatorBase.js').ValidationResult[]} results
   */
  _validateFuBen(xmlDoc, results) {
    const text = getAllTextUnder(xmlDoc, '副本');

    // Rule 1: Unreplaced placeholder check.
    if (text.includes('○')) {
      results.push({
        field: '副本',
        message: '副本欄位包含有未修改字元「○」請確認是否匯出!',
      });
    }

    // Rule 2: Forbidden recipients check.
    const hasForbidden = FORBIDDEN_CC_TERMS.some((term) => text.includes(term));
    if (hasForbidden) {
      results.push({
        field: '副本',
        message:
          '副本欄位包含本府研考會、本府府會總聯絡人、本局府會聯絡人，副本無須副知他們，請確認是否匯出!',
      });
    }
  }
}
