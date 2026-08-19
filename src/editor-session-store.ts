// @ts-nocheck

const DB_NAME = 'pdf-page-editor';
const DB_VERSION = 3;
const STORE_NAME = 'sessions';
const PAGE_ASSETS_STORE = 'pageAssets';

export const EDITOR_PDF_KEY = 'pdf';
export const EDITOR_STATE_KEY = 'state';

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = request.result;
      const oldVersion = event.oldVersion;

      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }

      if (!db.objectStoreNames.contains(PAGE_ASSETS_STORE)) {
        db.createObjectStore(PAGE_ASSETS_STORE, { keyPath: 'id' });
      } else if (oldVersion > 0 && oldVersion < 3) {
        db.deleteObjectStore(PAGE_ASSETS_STORE);
        db.createObjectStore(PAGE_ASSETS_STORE, { keyPath: 'id' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function runWriteTransaction(storeNames, fn) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(storeNames, 'readwrite');
        const stores = storeNames.map((name) => tx.objectStore(name));
        let settled = false;
        let result;

        const finish = (value) => {
          if (settled) return;
          settled = true;
          db.close();
          resolve(value);
        };
        const fail = (error) => {
          if (settled) return;
          settled = true;
          db.close();
          reject(error);
        };

        tx.oncomplete = () => finish(result);
        tx.onerror = () => fail(tx.error);
        tx.onabort = () => fail(tx.error);

        Promise.resolve(fn(stores, tx))
          .then((value) => {
            result = value;
          })
          .catch((error) => {
            try {
              tx.abort();
            } catch (_err) {}
            fail(error);
          });
      })
  );
}

function runReadTransaction(storeNames, fn) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(storeNames, 'readonly');
        const stores = storeNames.map((name) => tx.objectStore(name));
        let settled = false;
        let result;

        const finish = (value) => {
          if (settled) return;
          settled = true;
          db.close();
          resolve(value);
        };
        const fail = (error) => {
          if (settled) return;
          settled = true;
          db.close();
          reject(error);
        };

        tx.oncomplete = () => finish(result);
        tx.onerror = () => fail(tx.error);
        tx.onabort = () => fail(tx.error);

        Promise.resolve(fn(stores))
          .then((value) => {
            result = value;
          })
          .catch(fail);
      })
  );
}

function putRecord(record) {
  return runWriteTransaction([STORE_NAME], ([store]) => {
    store.put(record);
  });
}

function getRecord(id) {
  return runReadTransaction([STORE_NAME], ([store]) => {
    return new Promise((resolve, reject) => {
      const request = store.get(id);
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error);
    });
  });
}

function deleteRecord(id) {
  return runWriteTransaction([STORE_NAME], ([store]) => {
    store.delete(id);
  });
}

function putPageAsset(asset) {
  return runWriteTransaction([PAGE_ASSETS_STORE], ([store]) => {
    store.put({
      id: asset.id,
      imageDataUrl: asset.imageDataUrl,
      updatedAt: asset.updatedAt ?? Date.now(),
    });
  });
}

function deletePageAsset(id) {
  return runWriteTransaction([PAGE_ASSETS_STORE], ([store]) => {
    store.delete(id);
  });
}

export function saveEditorPdfRecord(record) {
  return putRecord({ ...record, id: EDITOR_PDF_KEY });
}

export function saveEditorStateRecord(record) {
  return putRecord({ ...record, id: EDITOR_STATE_KEY });
}

export function loadPageAssetIds() {
  return runReadTransaction([PAGE_ASSETS_STORE], ([store]) => {
    return new Promise((resolve, reject) => {
      const request = store.getAllKeys();
      request.onsuccess = () => resolve(request.result ?? []);
      request.onerror = () => reject(request.error);
    });
  });
}

export async function savePageAssetsIncremental(assets) {
  const existingIds = await loadPageAssetIds();
  const nextIds = new Set(assets.map((asset) => asset.id));

  for (const id of existingIds) {
    if (!nextIds.has(id)) {
      await deletePageAsset(id);
    }
  }

  for (const asset of assets) {
    await putPageAsset(asset);
  }
}

export function loadPageAssets() {
  return runReadTransaction([PAGE_ASSETS_STORE], ([store]) => {
    return new Promise((resolve, reject) => {
      const request = store.getAll();
      request.onsuccess = () => {
        const map = new Map();
        for (const record of request.result ?? []) {
          if (!record?.id) continue;
          if (typeof record.imageDataUrl === 'string' && record.imageDataUrl) {
            map.set(record.id, record.imageDataUrl);
          }
        }
        resolve(map);
      };
      request.onerror = () => reject(request.error);
    });
  });
}

export function clearPageAssets() {
  return runWriteTransaction([PAGE_ASSETS_STORE], ([store]) => {
    store.clear();
  });
}

export async function loadEditorSession() {
  const [pdfRecord, stateRecord, legacyRecord, pageAssets] = await Promise.all([
    getRecord(EDITOR_PDF_KEY),
    getRecord(EDITOR_STATE_KEY),
    getRecord('current'),
    loadPageAssets(),
  ]);

  if (pdfRecord?.pdfData && stateRecord?.pageList?.length) {
    return {
      sourceFileName: pdfRecord.sourceFileName,
      originalFileName: pdfRecord.originalFileName,
      pdfData: pdfRecord.pdfData,
      pageList: stateRecord.pageList,
      currentPageIndex: stateRecord.currentPageIndex ?? 0,
      savedAt: stateRecord.savedAt ?? 0,
      pageAssets,
    };
  }

  if (legacyRecord?.pdfData && legacyRecord?.pageList?.length) {
    return {
      sourceFileName: legacyRecord.sourceFileName,
      originalFileName: legacyRecord.originalFileName,
      pdfData: legacyRecord.pdfData,
      pageList: legacyRecord.pageList,
      currentPageIndex: legacyRecord.currentPageIndex ?? 0,
      savedAt: legacyRecord.savedAt ?? 0,
      pageAssets: hydrateLegacyPageAssets(legacyRecord.pageList, pageAssets),
    };
  }

  return null;
}

function hydrateLegacyPageAssets(pageList, pageAssets) {
  const map = new Map(pageAssets);

  for (const page of pageList) {
    if (page?.id && page.customImageDataUrl) {
      map.set(page.id, page.customImageDataUrl);
    }
  }

  return map;
}

export async function clearEditorSession() {
  await Promise.all([
    deleteRecord(EDITOR_PDF_KEY),
    deleteRecord(EDITOR_STATE_KEY),
    deleteRecord('current'),
    clearPageAssets(),
  ]);
}
