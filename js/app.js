/**
 * @fileoverview Main application coordinator for ODAssistant2.
 *
 * Bootstraps all modules, wires up the UI, and manages application lifecycle:
 *  1. Register Service Worker
 *  2. Open IndexedDB
 *  3. Initialise DataRepository, TemplateStore, DriveSync, DraftManager,
 *     ValidationEngine, ExportService, EditorUI
 *  4. Background sync from Google Drive
 *  5. Draft restoration / template selection
 *  6. Wire toolbar buttons (儲存草稿, 匯出, 設定)
 */

import { openDB }             from './db.js';
import { parse }              from './DIParser.js';
import { DataRepository }     from './DataRepository.js';
import { TemplateStore }      from './TemplateStore.js';
import { DriveSync }          from './DriveSync.js';
import { DraftManager }       from './DraftManager.js';
import { ExportService }      from './ExportService.js';
import { EditorUI }           from './EditorUI.js';
import { ValidationEngine }   from './validation/ValidationEngine.js';

// ─── Module-level state ──────────────────────────────────────────────────────

/** @type {DataRepository} */
let dataRepo;
/** @type {TemplateStore} */
let templateStore;
/** @type {DriveSync} */
let driveSync;
/** @type {DraftManager} */
let draftManager;
/** @type {ValidationEngine} */
let validationEngine;
/** @type {ExportService} */
let exportService;
/** @type {EditorUI} */
let editorUI;

/** Currently loaded XML document. @type {Document|null} */
let _xmlDoc    = null;
/** Current template filename. @type {string|null} */
let _xmlDecl   = null;
/** Current DOCTYPE string. @type {string|null} */
let _doctype   = null;
/** Current template filename. @type {string|null} */
let _templateFilename = null;

// ─── Bootstrap ───────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  _boot().catch((err) => {
    console.error('[app] 啟動失敗：', err);
    showNotification('系統啟動失敗：' + err.message, 'error');
  });
});

async function _boot() {
  // 1. Service Worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch((err) => {
      console.warn('[app] Service Worker 註冊失敗：', err);
    });
  }

  // 2. IndexedDB
  const db = await openDB();

  // 3. Initialise modules
  dataRepo        = new DataRepository();
  templateStore   = new TemplateStore(db);
  driveSync       = new DriveSync(db);
  draftManager    = new DraftManager(db);
  validationEngine = new ValidationEngine(dataRepo);
  exportService   = new ExportService(validationEngine, null);

  const editorContainer = document.getElementById('editor-container');
  editorUI = new EditorUI(editorContainer);
  editorUI.onChange(() => {
    // Optionally mark as dirty — auto-save handles persistence
  });

  await Promise.all([
    dataRepo.init(),
    templateStore.init(),
  ]);

  // 4. Background sync
  _syncInBackground();

  // 5. Check draft and show template selector
  const draft = await draftManager.load();
  openTemplateSelector(draft);

  // 6. Wire toolbar
  _wireToolbar();
}

// ─── Background sync ─────────────────────────────────────────────────────────

async function _syncInBackground() {
  const statusEl = document.getElementById('sync-status');
  if (statusEl) statusEl.textContent = '正在檢查更新...';

  try {
    const result = await driveSync.sync();

    if (result.error) {
      console.warn('[app] 同步警告：', result.error);
      if (statusEl) statusEl.textContent = '同步失敗';
      return;
    }

    if (!result.updated) {
      if (statusEl) statusEl.textContent = '已是最新';
      return;
    }

    // Process sync items
    for (const item of result.items) {
      if (item.type === 'template') {
        await templateStore.saveTemplate({
          filename:     item.filename,
          content:      item.content,
          modifiedTime: item.modifiedTime,
        });
      } else if (item.type === 'legislators') {
        await dataRepo.loadLegislatorsCSV(item.content);
      } else if (item.type === 'groups') {
        await dataRepo.loadGroupsCSV(item.content);
      }
    }

    if (statusEl) statusEl.textContent = `已更新 ${result.items.length} 個檔案`;
    showNotification(`已從 Google Drive 更新 ${result.items.length} 個檔案`, 'success');
  } catch (err) {
    console.error('[app] 同步錯誤：', err);
    if (statusEl) statusEl.textContent = '同步錯誤';
  }
}

// ─── Template selection modal ────────────────────────────────────────────────

/**
 * Show the template selector modal.
 * @param {import('./DraftManager.js').DraftRecord|null} draft
 */
export function openTemplateSelector(draft) {
  const modal      = document.getElementById('modal-template');
  const listEl     = document.getElementById('template-list');
  const draftBtnEl = document.getElementById('btn-restore-draft');
  const draftInfoEl = document.getElementById('draft-info');

  if (!modal || !listEl) return;

  // Clear previous list
  listEl.innerHTML = '';

  // Show draft restore option if a draft exists
  if (draft && draftBtnEl && draftInfoEl) {
    const savedDate = new Date(draft.savedAt).toLocaleString('zh-TW');
    draftInfoEl.textContent = `上次儲存：${savedDate} — 範本：${draft.templateFilename}`;
    draftBtnEl.style.display = '';
    draftBtnEl.onclick = () => {
      _loadFromDraft(draft);
      _closeModal(modal);
    };
  } else if (draftBtnEl) {
    draftBtnEl.style.display = 'none';
  }

  // Populate template list
  const templates = templateStore.getList();

  if (templates.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'template-list__empty';
    empty.textContent = '尚無可用範本。請先在設定中填入 Google Drive 資料夾 ID 並同步。';
    listEl.appendChild(empty);
  } else {
    templates.forEach(({ filename }) => {
      const btn = document.createElement('button');
      btn.className   = 'template-list__item';
      btn.type        = 'button';
      btn.textContent = templateStore.getDisplayName(filename);
      btn.title       = filename;
      btn.addEventListener('click', async () => {
        await _loadTemplate(filename);
        _closeModal(modal);
      });
      listEl.appendChild(btn);
    });
  }

  modal.classList.add('modal--open');
  modal.removeAttribute('hidden');
}

// ─── Settings modal ───────────────────────────────────────────────────────────

/**
 * Show the settings modal.
 */
export async function openSettings() {
  const modal = document.getElementById('modal-settings');
  if (!modal) return;

  const config = await driveSync.getConfig();
  const baseUrlInput = /** @type {HTMLInputElement|null} */ (document.getElementById('settings-base-url'));

  if (baseUrlInput) baseUrlInput.value = config?.baseUrl ?? '';

  modal.classList.add('modal--open');
  modal.removeAttribute('hidden');
}

// ─── Notification toast ───────────────────────────────────────────────────────

/**
 * Show a temporary toast notification.
 *
 * @param {string} message
 * @param {'success'|'error'|'info'|'warning'} [type='info']
 */
export function showNotification(message, type = 'info') {
  const container = document.getElementById('notifications') ?? _createNotificationContainer();

  const toast = document.createElement('div');
  toast.className = `toast toast--${type}`;
  toast.setAttribute('role', 'alert');
  toast.textContent = message;

  container.appendChild(toast);

  // Auto-remove after 4 seconds
  setTimeout(() => {
    toast.classList.add('toast--hide');
    toast.addEventListener('transitionend', () => toast.remove(), { once: true });
  }, 4000);
}

function _createNotificationContainer() {
  const div = document.createElement('div');
  div.id = 'notifications';
  document.body.appendChild(div);
  return div;
}

// ─── Validation modal ─────────────────────────────────────────────────────────

/**
 * Show the validation warnings modal.
 *
 * @param {import('./validation/ValidatorBase.js').ValidationResult[]} warnings
 * @param {Function} onConfirm  - Called when the user clicks "仍要匯出".
 */
export function showValidationModal(warnings, onConfirm) {
  const modal   = document.getElementById('modal-validation');
  const listEl  = document.getElementById('validation-list');
  const confirmBtn = document.getElementById('btn-validation-confirm');
  const cancelBtn  = document.getElementById('btn-validation-cancel');

  if (!modal || !listEl) {
    // Fallback if modal HTML is missing
    const hasErrors = warnings.some((w) => w.level === 'error');
    if (!hasErrors && confirm('驗證發現警告，仍要繼續匯出？\n\n' + warnings.map((w) => w.message).join('\n'))) {
      onConfirm();
    }
    return;
  }

  listEl.innerHTML = '';

  const hasErrors = warnings.some((w) => w.level === 'error');

  warnings.forEach((w) => {
    const item = document.createElement('li');
    item.className = `validation-item validation-item--${w.level ?? 'warning'}`;
    item.textContent = w.field ? `[${w.field}] ${w.message}` : w.message;
    listEl.appendChild(item);
  });

  if (confirmBtn) {
    confirmBtn.disabled = hasErrors;
    confirmBtn.textContent = hasErrors ? '無法匯出（請修正錯誤）' : '仍要匯出';
    confirmBtn.onclick = () => {
      _closeModal(modal);
      onConfirm();
    };
  }

  if (cancelBtn) {
    cancelBtn.onclick = () => _closeModal(modal);
  }

  modal.classList.add('modal--open');
  modal.removeAttribute('hidden');
}

// ─── Load helpers ─────────────────────────────────────────────────────────────

async function _loadTemplate(filename) {
  try {
    const content = await templateStore.getContent(filename);
    const { xmlDecl, doctype, xmlDoc } = parse(content);

    _xmlDoc           = xmlDoc;
    _xmlDecl          = xmlDecl;
    _doctype          = doctype;
    _templateFilename = filename;

    editorUI.render(xmlDoc);
    draftManager.stopAutoSave();
    draftManager.startAutoSave(() => _getEditorState());

    _updateDocumentTitle(filename);
    showNotification(`已載入範本：${templateStore.getDisplayName(filename)}`, 'success');
  } catch (err) {
    console.error('[app] 載入範本失敗：', err);
    showNotification(`載入範本失敗：${err.message}`, 'error');
  }
}

async function _loadFromDraft(draft) {
  try {
    const { xmlDecl, doctype, xmlDoc } = parse(draft.xmlContent);

    _xmlDoc           = xmlDoc;
    _xmlDecl          = xmlDecl;
    _doctype          = doctype;
    _templateFilename = draft.templateFilename;

    editorUI.render(xmlDoc);
    draftManager.stopAutoSave();
    draftManager.startAutoSave(() => _getEditorState());

    _updateDocumentTitle(draft.templateFilename);
    const savedDate = new Date(draft.savedAt).toLocaleString('zh-TW');
    showNotification(`已還原草稿（${savedDate}）`, 'success');
  } catch (err) {
    console.error('[app] 草稿還原失敗：', err);
    showNotification(`草稿還原失敗：${err.message}`, 'error');
  }
}

// ─── Toolbar wiring ───────────────────────────────────────────────────────────

function _wireToolbar() {
  // 儲存草稿
  const saveDraftBtn = document.getElementById('btn-save-draft');
  if (saveDraftBtn) {
    saveDraftBtn.addEventListener('click', async () => {
      const state = _getEditorState();
      if (!state) {
        showNotification('請先開啟或選擇一個範本', 'warning');
        return;
      }
      try {
        await draftManager.save(state.templateFilename, state.xmlContent);
        showNotification('草稿已儲存', 'success');
      } catch (err) {
        showNotification(`草稿儲存失敗：${err.message}`, 'error');
      }
    });
  }

  // 匯出
  const exportBtn = document.getElementById('btn-export');
  if (exportBtn) {
    exportBtn.addEventListener('click', async () => {
      const doc = editorUI.getDocument();
      if (!doc || !_templateFilename) {
        showNotification('請先開啟或選擇一個範本', 'warning');
        return;
      }

      const caseType = templateStore.getCaseType(_templateFilename);
      const filename = _templateFilename.replace(/\.di$/i, '_export.di');

      try {
        const prep = await exportService.prepareExport(
          doc, _doctype ?? '', _xmlDecl ?? '', caseType, filename
        );

        if (prep.warnings.length === 0) {
          // No warnings — export directly
          prep.proceed();
          showNotification('文件已匯出', 'success');
        } else {
          showValidationModal(prep.warnings, () => {
            prep.proceed();
            showNotification('文件已匯出', 'success');
          });
        }
      } catch (err) {
        showNotification(`匯出失敗：${err.message}`, 'error');
      }
    });
  }

  // 設定
  const settingsBtn = document.getElementById('btn-settings');
  if (settingsBtn) {
    settingsBtn.addEventListener('click', () => openSettings());
  }

  // 選擇範本
  const templateBtn = document.getElementById('btn-select-template');
  if (templateBtn) {
    templateBtn.addEventListener('click', async () => {
      const draft = await draftManager.load();
      openTemplateSelector(draft);
    });
  }

  // Settings form save
  const saveSettingsBtn = document.getElementById('btn-save-settings');
  if (saveSettingsBtn) {
    saveSettingsBtn.addEventListener('click', async () => {
      const baseUrlInput = /** @type {HTMLInputElement|null} */ (document.getElementById('settings-base-url'));
      const baseUrl = baseUrlInput?.value?.trim() ?? '';
      try {
        await driveSync.saveConfig(baseUrl);
        showNotification('設定已儲存', 'success');
        const modal = document.getElementById('modal-settings');
        if (modal) _closeModal(modal);
        // Trigger sync with new config
        _syncInBackground();
      } catch (err) {
        showNotification(`設定儲存失敗：${err.message}`, 'error');
      }
    });
  }

  // Modal close buttons (data-close-modal attribute)
  document.addEventListener('click', (e) => {
    const target = /** @type {HTMLElement} */ (e.target);
    if (target.dataset.closeModal) {
      const modal = document.getElementById(target.dataset.closeModal);
      if (modal) _closeModal(modal);
    }
    // Click outside modal content closes it
    if (target.classList.contains('modal')) {
      _closeModal(target);
    }
  });

  // Keyboard ESC closes open modals
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      document.querySelectorAll('.modal--open').forEach((m) => _closeModal(/** @type {HTMLElement} */(m)));
    }
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _getEditorState() {
  const doc = editorUI?.getDocument();
  if (!doc || !_templateFilename) return null;

  const serialiser = new XMLSerializer();
  let xmlContent   = serialiser.serializeToString(doc);
  xmlContent       = xmlContent.replace(/^<\?xml[^?]*\?>\s*/i, '');
  const parts = [];
  if (_xmlDecl)  parts.push(_xmlDecl);
  if (_doctype)  parts.push(_doctype);
  parts.push(xmlContent);

  return {
    templateFilename: _templateFilename,
    xmlContent:       parts.join('\n'),
  };
}

function _updateDocumentTitle(filename) {
  const titleEl = document.getElementById('document-title');
  if (titleEl) {
    titleEl.textContent = templateStore.getDisplayName(filename);
  }
  document.title = `${templateStore.getDisplayName(filename)} — 公文寫作輔助系統`;
}

function _closeModal(modal) {
  modal.classList.remove('modal--open');
  modal.setAttribute('hidden', '');
}
