/**
 * @fileoverview IndexedDB wrapper for ODAssistant2.
 * Provides a promise-based API over the raw IndexedDB interface.
 * All application data stays local — no network persistence.
 */

/** @type {string} */
const DB_NAME = 'ODAssistant2';

/** @type {number} */
const DB_VERSION = 1;

/**
 * Store name constants.
 * @enum {string}
 */
export const STORES = {
  /** Cached DI template files: {filename, content, modifiedTime} */
  TEMPLATES: 'templates',
  /** Single global draft: {id: 'current', templateFilename, xmlContent, savedAt} */
  DRAFT: 'draft',
  /** Keyed application data (legislators list, groups list, syncMeta): {id, payload} */
  DATA: 'data',
  /** User/app settings (Drive config, etc.): {id, value} */
  SETTINGS: 'settings',
};

/** @type {IDBDatabase | null} */
let _db = null;

/**
 * Open (or reuse) the IndexedDB database, creating object stores on first run.
 *
 * @returns {Promise<IDBDatabase>} Resolves with the open database instance.
 */
export function openDB() {
  if (_db) return Promise.resolve(_db);

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = /** @type {IDBOpenDBRequest} */ (event.target).result;

      // templates — keyed by filename
      if (!db.objectStoreNames.contains(STORES.TEMPLATES)) {
        db.createObjectStore(STORES.TEMPLATES, { keyPath: 'filename' });
      }

      // draft — single record with id 'current'
      if (!db.objectStoreNames.contains(STORES.DRAFT)) {
        db.createObjectStore(STORES.DRAFT, { keyPath: 'id' });
      }

      // data — general key-value store
      if (!db.objectStoreNames.contains(STORES.DATA)) {
        db.createObjectStore(STORES.DATA, { keyPath: 'id' });
      }

      // settings — general key-value store
      if (!db.objectStoreNames.contains(STORES.SETTINGS)) {
        db.createObjectStore(STORES.SETTINGS, { keyPath: 'id' });
      }
    };

    request.onsuccess = (event) => {
      _db = /** @type {IDBOpenDBRequest} */ (event.target).result;

      // If the connection is forcibly closed (e.g. version upgrade from another tab),
      // clear the cached reference so the next call reopens cleanly.
      _db.onversionchange = () => {
        _db.close();
        _db = null;
      };

      resolve(_db);
    };

    request.onerror = (event) => {
      reject(
        new Error(
          `Failed to open IndexedDB "${DB_NAME}": ${
            /** @type {IDBOpenDBRequest} */ (event.target).error?.message ?? 'unknown error'
          }`
        )
      );
    };
  });
}

/**
 * Retrieve a single record by key from the given store.
 *
 * @param {string} store  One of the {@link STORES} values.
 * @param {string} key    The record's primary key.
 * @returns {Promise<any>} Resolves with the record, or `undefined` if not found.
 */
export async function get(store, key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () =>
      reject(new Error(`db.get(${store}, ${key}): ${req.error?.message}`));
  });
}

/**
 * Retrieve all records from the given store.
 *
 * @param {string} store  One of the {@link STORES} values.
 * @returns {Promise<any[]>} Resolves with an array of all records (may be empty).
 */
export async function getAll(store) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () =>
      reject(new Error(`db.getAll(${store}): ${req.error?.message}`));
  });
}

/**
 * Insert or update a record in the given store (upsert semantics).
 * The value must include the store's keyPath field.
 *
 * @param {string} store   One of the {@link STORES} values.
 * @param {object} value   The record to store.
 * @returns {Promise<IDBValidKey>} Resolves with the stored record's key.
 */
export async function put(store, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    const req = tx.objectStore(store).put(value);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () =>
      reject(new Error(`db.put(${store}): ${req.error?.message}`));
  });
}

/**
 * Delete a record by key from the given store.
 * Resolves successfully even if the key does not exist.
 *
 * @param {string} store  One of the {@link STORES} values.
 * @param {string} key    The primary key of the record to delete.
 * @returns {Promise<void>}
 */
export async function del(store, key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    const req = tx.objectStore(store).delete(key);
    req.onsuccess = () => resolve();
    req.onerror = () =>
      reject(new Error(`db.del(${store}, ${key}): ${req.error?.message}`));
  });
}
