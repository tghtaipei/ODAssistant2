/**
 * @fileoverview 從公開的 GitHub 儲存庫同步 DI 範本與 CSV 資料檔。
 *
 * 使用 GitHub Contents API（公開儲存庫不需要 API 金鑰）自動列出目錄，
 * 不需要 manifest.json — 所有 .di 副檔名的檔案都視為範本，
 * 「議員分組.csv」作為議員名單與組別對應表。
 *
 * Base URL 格式：
 *   https://raw.githubusercontent.com/{owner}/{repo}/{branch}/{path}
 *   例：https://raw.githubusercontent.com/tghtaipei/od-templates/main/templates
 */

import { get, put, STORES } from './db.js';

/** IndexedDB key for caching file SHAs (to detect changes). */
const SYNC_META_KEY = 'syncMeta';

/** Settings key. */
const SETTINGS_BASE_URL = 'syncBaseUrl';

/** CSV 檔名（固定） */
const MEMBER_CSV_NAME = '議員分組.csv';

/**
 * @typedef {Object} SyncItemTemplate
 * @property {'template'} type
 * @property {string}     filename
 * @property {string}     content
 * @property {string}     modifiedTime
 */

/**
 * @typedef {Object} SyncItemMemberGroup
 * @property {'memberGroup'} type
 * @property {string}        content
 */

/**
 * @typedef {SyncItemTemplate|SyncItemMemberGroup} SyncItem
 */

/**
 * @typedef {Object} SyncResult
 * @property {boolean}     updated
 * @property {SyncItem[]}  items
 * @property {string|null} error
 */

export class DriveSync {
  /**
   * @param {object} db - Kept for API symmetry.
   */
  constructor(db) {
    this._db = db;
  }

  // ---------------------------------------------------------------------------
  // Config helpers
  // ---------------------------------------------------------------------------

  /**
   * @returns {Promise<{baseUrl: string}|null>}
   */
  async getConfig() {
    const record = await get(STORES.SETTINGS, SETTINGS_BASE_URL);
    const baseUrl = (record?.value ?? '').trim().replace(/\/$/, '');
    if (!baseUrl) return null;
    return { baseUrl };
  }

  /**
   * @param {string} baseUrl
   */
  async saveConfig(baseUrl) {
    await put(STORES.SETTINGS, {
      id:    SETTINGS_BASE_URL,
      value: baseUrl.trim().replace(/\/$/, ''),
    });
  }

  // ---------------------------------------------------------------------------
  // GitHub API helpers
  // ---------------------------------------------------------------------------

  /**
   * 將 raw.githubusercontent.com 網址轉換為 GitHub Contents API 網址。
   *
   * 輸入：https://raw.githubusercontent.com/owner/repo/branch/path
   * 輸出：https://api.github.com/repos/owner/repo/contents/path?ref=branch
   *
   * @param {string} baseUrl
   * @returns {string|null}
   */
  _buildApiUrl(baseUrl) {
    const m = baseUrl.match(
      /^https?:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)(?:\/(.+))?$/
    );
    if (!m) return null;
    const [, owner, repo, branch, path] = m;
    return `https://api.github.com/repos/${owner}/${repo}/contents/${path ?? ''}?ref=${branch}`;
  }

  /**
   * 呼叫 GitHub Contents API 列出目錄檔案。
   *
   * @param {string} baseUrl
   * @returns {Promise<Array<{name: string, sha: string, download_url: string, type: string}>>}
   */
  async _listDirectory(baseUrl) {
    const apiUrl = this._buildApiUrl(baseUrl);
    if (!apiUrl) {
      throw new Error('不支援的網址格式，請使用 raw.githubusercontent.com 網址。');
    }

    const resp = await fetch(apiUrl, {
      headers: { 'Accept': 'application/vnd.github.v3+json' },
      cache: 'no-cache',
    });

    if (resp.status === 403) {
      throw new Error('GitHub API 速率限制，請稍後再試。');
    }
    if (!resp.ok) {
      throw new Error(`無法讀取範本目錄（HTTP ${resp.status}）`);
    }

    return resp.json();
  }

  // ---------------------------------------------------------------------------
  // Main sync
  // ---------------------------------------------------------------------------

  /**
   * 同步所有 .di 範本及議員分組 CSV。
   * 利用 GitHub API 回傳的 SHA 判斷檔案是否有變動，避免重複下載。
   *
   * @returns {Promise<SyncResult>}
   */
  async sync() {
    /** @type {SyncItem[]} */
    const items = [];

    let config;
    try {
      config = await this.getConfig();
    } catch (err) {
      return { updated: false, items, error: `讀取設定失敗：${err.message}` };
    }

    if (!config) {
      return { updated: false, items, error: null };
    }

    const { baseUrl } = config;

    // 1. 列出目錄
    let entries;
    try {
      entries = await this._listDirectory(baseUrl);
    } catch (err) {
      return { updated: false, items, error: err.message };
    }

    // 2. 載入快取的 SHA
    let syncMeta = {};
    try {
      const metaRecord = await get(STORES.DATA, SYNC_META_KEY);
      syncMeta = metaRecord?.payload ?? {};
    } catch (_) {
      syncMeta = {};
    }

    const updatedMeta = { ...syncMeta };
    let anyUpdated = false;

    // 3. 處理每個檔案
    for (const entry of entries) {
      if (entry.type !== 'file') continue;

      const name = entry.name;
      const isDi        = /\.di$/i.test(name);
      const isMemberCsv = name === MEMBER_CSV_NAME;

      if (!isDi && !isMemberCsv) continue;

      // SHA 相同表示檔案未變動
      if (syncMeta[name] === entry.sha) continue;

      let content;
      try {
        const fileResp = await fetch(entry.download_url, { cache: 'no-cache' });
        if (!fileResp.ok) throw new Error(`HTTP ${fileResp.status}`);
        content = await fileResp.text();
      } catch (err) {
        console.warn(`[DriveSync] 跳過 "${name}"：${err.message}`);
        continue;
      }

      if (isDi) {
        items.push({
          type: 'template',
          filename: name,
          content,
          modifiedTime: entry.sha,
        });
      } else if (isMemberCsv) {
        items.push({ type: 'memberGroup', content });
      }

      updatedMeta[name] = entry.sha;
      anyUpdated = true;
    }

    // 4. 更新快取 SHA
    if (anyUpdated) {
      try {
        await put(STORES.DATA, { id: SYNC_META_KEY, payload: updatedMeta });
      } catch (err) {
        console.warn('[DriveSync] syncMeta 寫入失敗：', err);
      }
    }

    return { updated: anyUpdated, items, error: null };
  }
}
