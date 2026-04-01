/**
 * @fileoverview Syncs DI templates and data CSVs from a public Google Drive folder.
 * Uses the Google Drive v3 REST API with an API key (no OAuth required for public folders).
 */

import { get, put, STORES } from './db.js';

/** @type {string} */
const DRIVE_FILES_URL = 'https://www.googleapis.com/drive/v3/files';

/** IndexedDB key used to persist sync metadata (last-known modifiedTimes). */
const SYNC_META_KEY = 'syncMeta';

/** Settings keys. */
const SETTINGS_FOLDER_ID = 'driveFolderId';
const SETTINGS_API_KEY   = 'driveApiKey';

/**
 * @typedef {Object} DriveFile
 * @property {string} id
 * @property {string} name
 * @property {string} modifiedTime  - ISO 8601
 * @property {string} mimeType
 */

/**
 * @typedef {Object} SyncItemTemplate
 * @property {'template'} type
 * @property {string}     filename
 * @property {string}     content
 * @property {string}     modifiedTime
 */

/**
 * @typedef {Object} SyncItemData
 * @property {'legislators'|'groups'} type
 * @property {string}                 content  - Raw CSV text
 */

/**
 * @typedef {SyncItemTemplate|SyncItemData} SyncItem
 */

/**
 * @typedef {Object} SyncResult
 * @property {boolean}     updated  - True if at least one file was downloaded.
 * @property {SyncItem[]}  items    - All downloaded items.
 * @property {string|null} error    - Error message, or null on success.
 */

export class DriveSync {
  /**
   * @param {import('./db.js').IDBDatabase} db  - Kept for API symmetry; calls go via helpers.
   */
  constructor(db) {
    /** @private */
    this._db = db;
  }

  // ---------------------------------------------------------------------------
  // Config helpers
  // ---------------------------------------------------------------------------

  /**
   * Read Drive configuration from the settings store.
   *
   * @returns {Promise<{folderId: string, apiKey: string}|null>}
   *   Null when either value is missing/empty.
   */
  async getConfig() {
    const [folderRecord, keyRecord] = await Promise.all([
      get(STORES.SETTINGS, SETTINGS_FOLDER_ID),
      get(STORES.SETTINGS, SETTINGS_API_KEY),
    ]);

    const folderId = folderRecord?.value ?? '';
    const apiKey   = keyRecord?.value   ?? '';

    if (!folderId || !apiKey) return null;

    return { folderId, apiKey };
  }

  /**
   * Persist Drive configuration.
   *
   * @param {string} folderId
   * @param {string} apiKey
   * @returns {Promise<void>}
   */
  async saveConfig(folderId, apiKey) {
    await Promise.all([
      put(STORES.SETTINGS, { id: SETTINGS_FOLDER_ID, value: folderId }),
      put(STORES.SETTINGS, { id: SETTINGS_API_KEY,   value: apiKey   }),
    ]);
  }

  // ---------------------------------------------------------------------------
  // Drive API calls
  // ---------------------------------------------------------------------------

  /**
   * List all files inside a Google Drive folder.
   *
   * @param {string} folderId
   * @param {string} apiKey
   * @returns {Promise<DriveFile[]>}
   * @throws {Error} On network or API errors.
   */
  async listFiles(folderId, apiKey) {
    const params = new URLSearchParams({
      q:       `'${folderId}' in parents and trashed = false`,
      fields:  'files(id,name,modifiedTime,mimeType)',
      key:     apiKey,
      pageSize: '1000',
    });

    const resp = await fetch(`${DRIVE_FILES_URL}?${params}`);

    if (!resp.ok) {
      let errMsg = `HTTP ${resp.status}`;
      try {
        const body = await resp.json();
        errMsg = body?.error?.message ?? errMsg;
      } catch (_) { /* ignore */ }
      throw new Error(`Drive 資料夾列舉失敗：${errMsg}`);
    }

    const data = await resp.json();
    return data.files ?? [];
  }

  /**
   * Download the text content of a single Drive file.
   *
   * @param {string} fileId
   * @param {string} apiKey
   * @returns {Promise<string>}
   * @throws {Error} On network or API errors.
   */
  async downloadFile(fileId, apiKey) {
    const params = new URLSearchParams({
      alt: 'media',
      key: apiKey,
    });

    const resp = await fetch(`${DRIVE_FILES_URL}/${encodeURIComponent(fileId)}?${params}`);

    if (!resp.ok) {
      let errMsg = `HTTP ${resp.status}`;
      try {
        const body = await resp.json();
        errMsg = body?.error?.message ?? errMsg;
      } catch (_) { /* ignore */ }
      throw new Error(`檔案下載失敗（${fileId}）：${errMsg}`);
    }

    return resp.text();
  }

  // ---------------------------------------------------------------------------
  // Main sync
  // ---------------------------------------------------------------------------

  /**
   * Sync DI templates and CSV data files from the configured Drive folder.
   *
   * Steps:
   *  1. Read saved Drive config — abort silently if not configured.
   *  2. List all files in the folder.
   *  3. Compare each file's modifiedTime against the cached syncMeta.
   *  4. Download files that are new or changed:
   *     - *.di          → SyncItemTemplate
   *     - legislators.csv → SyncItemData {type:'legislators'}
   *     - groups.csv    → SyncItemData {type:'groups'}
   *  5. Persist updated syncMeta.
   *
   * @returns {Promise<SyncResult>}
   */
  async sync() {
    /** @type {SyncItem[]} */
    const items = [];

    // 1. Get config.
    let config;
    try {
      config = await this.getConfig();
    } catch (err) {
      return { updated: false, items, error: `讀取設定失敗：${err.message}` };
    }

    if (!config) {
      // Not yet configured — silently skip.
      return { updated: false, items, error: null };
    }

    const { folderId, apiKey } = config;

    // 2. List Drive folder.
    let driveFiles;
    try {
      driveFiles = await this.listFiles(folderId, apiKey);
    } catch (err) {
      return { updated: false, items, error: err.message };
    }

    // 3. Load existing syncMeta from DB.
    let syncMeta = {};
    try {
      const metaRecord = await get(STORES.DATA, SYNC_META_KEY);
      syncMeta = metaRecord?.payload ?? {};
    } catch (_) {
      syncMeta = {};
    }

    const updatedMeta = { ...syncMeta };
    let anyUpdated = false;

    // 4. Process each file.
    for (const file of driveFiles) {
      const { id, name, modifiedTime } = file;

      const isDiTemplate   = /\.di$/i.test(name);
      const isLegislators  = name.toLowerCase() === 'legislators.csv';
      const isGroups        = name.toLowerCase() === 'groups.csv';

      if (!isDiTemplate && !isLegislators && !isGroups) continue;

      // Skip if unchanged.
      if (syncMeta[id] === modifiedTime) continue;

      let content;
      try {
        content = await this.downloadFile(id, apiKey);
      } catch (err) {
        console.warn(`[DriveSync] 跳過 "${name}"：${err.message}`);
        continue;
      }

      if (isDiTemplate) {
        items.push({ type: 'template', filename: name, content, modifiedTime });
      } else if (isLegislators) {
        items.push({ type: 'legislators', content });
      } else if (isGroups) {
        items.push({ type: 'groups', content });
      }

      updatedMeta[id] = modifiedTime;
      anyUpdated = true;
    }

    // 5. Persist updated meta.
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
