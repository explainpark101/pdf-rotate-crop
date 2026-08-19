// @ts-nocheck
import * as pdfjsLib from 'pdfjs-dist';
import { PDFDocument } from 'pdf-lib';
import {
  clearEditorSession,
  loadEditorSession,
  deletePageHistory,
  saveEditorPdfRecord,
  saveEditorStateRecord,
  savePageAssetsIncremental,
  savePageHistoryEvent,
  setPageHistoryEvents,
  setPageHistoryBaseline,
  setPageHistoryPointer,
} from '@/editor-session-store.ts';
import { gunzipSync } from 'fflate';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();

/* State Management */
let pdfDoc = null;
let pdfSourceData = null;
let sourceFileName = '';
let originalFileName = 'edited_document.pdf';
let currentRenderTask = null;

const pageCache = new Map();
const thumbnailCache = new Map();

const THUMB_ITEM_HEIGHT = 196;
const THUMB_OVERSCAN = 3;
let thumbnailVirtualList = null;
let virtualScrollRaf = null;

let pageList = [];
let currentPageIndex = -1;

// 페이지 단위 undo/redo를 위한 in-memory 상태
// - pageHistoryEventsMap: IndexedDB에서 복원/적용된 events 배열
// - pageHistoryPointerMap: 현재 적용된 이벤트 인덱스(undo/redo 시 변경)
// - pageHistoryBaselineMap: pointer=-1일 때의 기준 스냅샷
let pageHistoryEventsMap = new Map(); // pageId -> events[]
let pageHistoryPointerMap = new Map(); // pageId -> pointer
let pageHistoryBaselineMap = new Map(); // pageId -> snapshot
let isRestoredSession = false;
let trustedBaselinePageIds = new Set(); // DB에 baseline이 있는 페이지(또는 새로 생성된 페이지)

// Blob 기반 이미지 렌더링을 위해 생성하는 objectURL들을 추적/정리합니다.
const objectUrlRegistry = new Set();
function registerObjectUrl(url) {
  if (typeof url === 'string' && url.startsWith('blob:')) {
    objectUrlRegistry.add(url);
  }
}
function revokeRegisteredObjectUrls() {
  for (const url of objectUrlRegistry) {
    try {
      URL.revokeObjectURL(url);
    } catch (_e) {}
  }
  objectUrlRegistry.clear();
}

function dataUrlToBlob(dataUrl) {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) return null;
  const parts = dataUrl.split(',');
  if (parts.length < 2) return null;
  const meta = parts[0];
  const b64 = parts[1];

  const mimeMatch = /data:(.*?);base64/i.exec(meta);
  const mime = mimeMatch?.[1] || 'application/octet-stream';

  const binStr = atob(b64);
  const len = binStr.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binStr.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

let isCropMode = false;
let cropBox = { x: 0.1, y: 0.1, w: 0.8, h: 0.8 };
let cropBoxDraftSnapshot = null; // crop 모드 진입 시점의 박스(변경 여부 판단용)
let cropDraftDirty = false; // 현재 cropBox가 snapshot과 다른지 여부
let isDraggingCrop = false;
let isResizingCrop = false;
let activeHandle = null;
let dragStartX = 0, dragStartY = 0;
let cropStartBox = null;
let renderSeq = 0;

const CROP_PRESETS = {
  leftHalf: { x: 0, y: 0, w: 0.5, h: 1 },
  center80: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 },
};

const PDF_CANVAS_MAX_H_DEFAULT_CLASS = 'max-h-[calc(100dvh-8rem)]';
const PDF_CANVAS_MAX_H_CROP_CLASS = 'max-h-[calc(100dvh-11rem)]';
let pageRenderToastEl = null;
let pageRenderToastTimer = null;
let exportToastEl = null;
let pageInputDebounceTimer = null;
let sessionSaveTimer = null;
let sessionSaveInFlight = null;
let pdfSessionDirty = false;
let sessionNeedsSave = false;
const SESSION_SAVE_DELAY_MS = 500;
const PAGE_INDEX_CACHE_PREFIX = 'pdf-editor-page-index:';
// 페이지용 저장 이미지 해상도/품질
// - 이 값이 낮으면 이후 Export(다시 PDF 생성) 시 customImageDataUrl 기반 이미지가 저화질로 고정됩니다.
// A4 가로 폭(대략): 210mm 를 96dpi 기준으로 px로 환산
const A4_WIDTH_PX = Math.round((210 / 25.4) * 96);
const PAGE_IMAGE_STORAGE_MAX_WIDTH_KEY = 'pageStorageMaxWidthPx';
const PAGE_IMAGE_STORAGE_MAX_WIDTH_DEFAULT = 2500;

let PAGE_IMAGE_STORAGE_MAX_WIDTH = PAGE_IMAGE_STORAGE_MAX_WIDTH_DEFAULT;
try {
  const raw = localStorage.getItem(PAGE_IMAGE_STORAGE_MAX_WIDTH_KEY);
  const parsed = raw != null ? parseInt(raw, 10) : NaN;
  if (!Number.isNaN(parsed) && parsed > 0) PAGE_IMAGE_STORAGE_MAX_WIDTH = parsed;
} catch (_e) {}
// 사용자 설정값이 있더라도 A4 폭 미만이면 강제로 올립니다.
PAGE_IMAGE_STORAGE_MAX_WIDTH = Math.max(PAGE_IMAGE_STORAGE_MAX_WIDTH, A4_WIDTH_PX);
const PAGE_IMAGE_STORAGE_QUALITY = 1.0;
const PAGE_IMAGE_STORAGE_RENDER_SCALE = 2;

/* DOM Elements */
const pdfFileInput = document.getElementById('pdfFileInput');
const pdfProjectFileInput = document.getElementById('pdfProjectFileInput');
const btnOpenProjectFromDropzone = document.getElementById('btnOpenProjectFromDropzone');
const pageStorageMaxWidthInput = document.getElementById('pageStorageMaxWidthInput');
const dropzone = document.getElementById('dropzone');
const canvasWrapper = document.getElementById('canvasWrapper');
const pdfCanvas = document.getElementById('pdfCanvas');
const cropOverlay = document.getElementById('cropOverlay');
const cropSizeLabel = document.getElementById('cropSizeLabel');
const editorToolbar = document.getElementById('editorToolbar');
const thumbnailContainer = document.getElementById('thumbnailContainer');
const emptySidebarState = document.getElementById('emptySidebarState');

const docName = document.getElementById('docName');
const pageCount = document.getElementById('pageCount');
const currentPageNum = document.getElementById('currentPageNum');
const totalPagesNum = document.getElementById('totalPagesNum');
const rotationRange = document.getElementById('rotationRange');
const rotationInput = document.getElementById('rotationInput');
const btnRotateCw30 = document.getElementById('btnRotateCw30');
const btnRotateCcw30 = document.getElementById('btnRotateCcw30');
const btnRotateCw1 = document.getElementById('btnRotateCw1');
const btnRotateCcw1 = document.getElementById('btnRotateCcw1');
const btnRotateCw01 = document.getElementById('btnRotateCw01');
const btnRotateCcw01 = document.getElementById('btnRotateCcw01');
const btnResetRotate = document.getElementById('btnResetRotate');
const btnApplyRotationToPage = document.getElementById('btnApplyRotationToPage');
const btnToggleCrop = document.getElementById('btnToggleCrop');
const cropBtnText = document.getElementById('cropBtnText');
const cropPresetGroup = document.getElementById('cropPresetGroup');
const btnApplyCropToPage = document.getElementById('btnApplyCropToPage');
const btnAddCroppedPage = document.getElementById('btnAddCroppedPage');
const btnDeleteCurrentPage = document.getElementById('btnDeleteCurrentPage');
const btnPrevPage = document.getElementById('btnPrevPage');
const btnNextPage = document.getElementById('btnNextPage');
const btnUndoPage = document.getElementById('btnUndoPage');
const btnRedoPage = document.getElementById('btnRedoPage');
const btnExportPdf = document.getElementById('btnExportPdf');
const btnExportProject = document.getElementById('btnExportProject');
const btnShowShortcuts = document.getElementById('btnShowShortcuts');
const btnCloseProject = document.getElementById('btnCloseProject');
const btnDeleteProject = document.getElementById('btnDeleteProject');
const btnRestoreRecentSession = document.getElementById('btnRestoreRecentSession');
const btnClearRecentSession = document.getElementById('btnClearRecentSession');
const btnCopyClipboard = document.getElementById('btnCopyClipboard');
const loadingOverlay = document.getElementById('loadingOverlay');
const viewportContainer = document.getElementById('viewportContainer');

// ----- Modals (Shortcuts / Confirm) -----
let isShortcutsModalOpen = false;
let isConfirmCropExitModalOpen = false;
let confirmCropExitResolve = null;

let isConfirmDeleteProjectModalOpen = false;
let confirmDeleteProjectResolve = null;

let isConfirmAfterProjectExportModalOpen = false;
let confirmAfterProjectExportResolve = null;

let isConfirmAlsoSaveProjectModalOpen = false;
let confirmAlsoSaveProjectResolve = null;

function openShortcutsModal() {
  const el = document.getElementById('shortcutsModal');
  if (!el) return;
  el.classList.remove('hidden');
  isShortcutsModalOpen = true;
}

function closeShortcutsModal() {
  const el = document.getElementById('shortcutsModal');
  if (!el) return;
  el.classList.add('hidden');
  isShortcutsModalOpen = false;
}

function openConfirmCropExitModal() {
  const el = document.getElementById('confirmCropExitModal');
  if (!el) return Promise.resolve(false);
  el.classList.remove('hidden');
  isConfirmCropExitModalOpen = true;

  return new Promise((resolve) => {
    confirmCropExitResolve = resolve;
  });
}

function closeConfirmCropExitModal() {
  const el = document.getElementById('confirmCropExitModal');
  if (!el) return;
  el.classList.add('hidden');
  isConfirmCropExitModalOpen = false;
  confirmCropExitResolve = null;
}

function openConfirmDeleteProjectModal() {
  const el = document.getElementById('confirmDeleteProjectModal');
  if (!el) return Promise.resolve(false);
  el.classList.remove('hidden');
  isConfirmDeleteProjectModalOpen = true;
  return new Promise((resolve) => {
    confirmDeleteProjectResolve = resolve;
  });
}

function closeConfirmDeleteProjectModal() {
  const el = document.getElementById('confirmDeleteProjectModal');
  if (!el) return;
  el.classList.add('hidden');
  isConfirmDeleteProjectModalOpen = false;
  confirmDeleteProjectResolve = null;
}

function openConfirmAfterProjectExportModal() {
  const el = document.getElementById('confirmAfterProjectExportModal');
  if (!el) return Promise.resolve(false);
  el.classList.remove('hidden');
  isConfirmAfterProjectExportModalOpen = true;
  return new Promise((resolve) => {
    confirmAfterProjectExportResolve = resolve;
  });
}

function closeConfirmAfterProjectExportModal() {
  const el = document.getElementById('confirmAfterProjectExportModal');
  if (!el) return;
  el.classList.add('hidden');
  isConfirmAfterProjectExportModalOpen = false;
  confirmAfterProjectExportResolve = null;
}

function openConfirmAlsoSaveProjectModal() {
  const el = document.getElementById('confirmAlsoSaveProjectModal');
  if (!el) return Promise.resolve(false);
  el.classList.remove('hidden');
  isConfirmAlsoSaveProjectModalOpen = true;
  return new Promise((resolve) => {
    confirmAlsoSaveProjectResolve = resolve;
  });
}

function closeConfirmAlsoSaveProjectModal() {
  const el = document.getElementById('confirmAlsoSaveProjectModal');
  if (!el) return;
  el.classList.add('hidden');
  isConfirmAlsoSaveProjectModalOpen = false;
  confirmAlsoSaveProjectResolve = null;
}

// Create modal DOM once.
(() => {
  if (!document.getElementById('shortcutsModal')) {
    const overlay = document.createElement('div');
    overlay.id = 'shortcutsModal';
    overlay.className = 'hidden fixed inset-0 bg-black/50 z-[100] flex items-center justify-center px-4';
    overlay.innerHTML = `
      <div class="w-full max-w-lg bg-white rounded-xl shadow-xl border border-slate-200 p-4">
        <div class="flex items-center justify-between mb-3">
          <h3 class="font-bold text-slate-900">단축키</h3>
          <button id="btnCloseShortcutsModal" class="px-2 py-1 rounded hover:bg-slate-100 text-slate-700">닫기</button>
        </div>
        <div class="text-sm text-slate-700 space-y-3">
          <div><div class="font-semibold text-slate-900">회전</div><div class="mt-1">Enter(적용) / q,e (±1도), Shift+q/e=±10도, Alt(opt)+q/e=±0.1도</div></div>
          <div><div class="font-semibold text-slate-900">Crop 모드</div><div class="mt-1">c=모드 토글 / Enter(현재 crop 적용) / a=왼쪽 50% 프리셋 / s=중앙 80% 프리셋</div></div>
          <div><div class="font-semibold text-slate-900">Crop 수정</div><div class="mt-1">Arrow=이동 / Alt+Arrow=크기(10px 단위)</div></div>
        </div>
        <div class="mt-4 text-xs text-slate-500">
          모달이 열려있을 때는 다른 단축키가 일시적으로 동작하지 않습니다. (Esc로 닫기)
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const btn = overlay.querySelector('#btnCloseShortcutsModal');
    btn?.addEventListener('click', closeShortcutsModal);
  }

  if (!document.getElementById('confirmCropExitModal')) {
    const overlay = document.createElement('div');
    overlay.id = 'confirmCropExitModal';
    overlay.className = 'hidden fixed inset-0 bg-black/50 z-[100] flex items-center justify-center px-4';
    overlay.innerHTML = `
      <div class="w-full max-w-md bg-white rounded-xl shadow-xl border border-slate-200 p-4">
        <div class="font-bold text-slate-900 mb-2">Crop 변경을 취소할까요?</div>
        <div class="text-sm text-slate-700 mb-4">현재 crop 박스 수정 내용을 버리고 crop 모드를 종료합니다.</div>
        <div class="flex items-center justify-end gap-2">
          <button id="btnCancelConfirmCropExit" class="px-3 py-2 rounded bg-slate-100 hover:bg-slate-200 text-slate-800">취소</button>
          <button id="btnConfirmConfirmCropExit" class="px-3 py-2 rounded bg-blue-600 hover:bg-blue-500 text-white">확인</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    overlay.querySelector('#btnCancelConfirmCropExit')?.addEventListener('click', () => {
      if (confirmCropExitResolve) confirmCropExitResolve(false);
      closeConfirmCropExitModal();
    });
    overlay.querySelector('#btnConfirmConfirmCropExit')?.addEventListener('click', () => {
      if (confirmCropExitResolve) confirmCropExitResolve(true);
      closeConfirmCropExitModal();
    });
  }

  if (!document.getElementById('confirmDeleteProjectModal')) {
    const overlay = document.createElement('div');
    overlay.id = 'confirmDeleteProjectModal';
    overlay.className = 'hidden fixed inset-0 bg-black/50 z-[100] flex items-center justify-center px-4';
    overlay.innerHTML = `
      <div class="w-full max-w-md bg-white rounded-xl shadow-xl border border-slate-200 p-4">
        <div class="font-bold text-slate-900 mb-2">프로젝트를 삭제할까요?</div>
        <div class="text-sm text-slate-700 mb-4">
          IndexedDB에 저장된 프로젝트(원본 PDF/편집 상태)를 삭제합니다. 되돌릴 수 없습니다.
        </div>
        <div class="flex items-center justify-end gap-2">
          <button id="btnCancelConfirmDeleteProject" class="px-3 py-2 rounded bg-slate-100 hover:bg-slate-200 text-slate-800">취소</button>
          <button id="btnConfirmConfirmDeleteProject" class="px-3 py-2 rounded bg-rose-600 hover:bg-rose-500 text-white">삭제</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    overlay.querySelector('#btnCancelConfirmDeleteProject')?.addEventListener('click', () => {
      if (confirmDeleteProjectResolve) confirmDeleteProjectResolve(false);
      closeConfirmDeleteProjectModal();
    });
    overlay.querySelector('#btnConfirmConfirmDeleteProject')?.addEventListener('click', () => {
      if (confirmDeleteProjectResolve) confirmDeleteProjectResolve(true);
      closeConfirmDeleteProjectModal();
    });
  }

  if (!document.getElementById('confirmAfterProjectExportModal')) {
    const overlay = document.createElement('div');
    overlay.id = 'confirmAfterProjectExportModal';
    overlay.className = 'hidden fixed inset-0 bg-black/50 z-[100] flex items-center justify-center px-4';
    overlay.innerHTML = `
      <div class="w-full max-w-md bg-white rounded-xl shadow-xl border border-slate-200 p-4">
        <div class="font-bold text-slate-900 mb-2">프로젝트를 정리할까요?</div>
        <div class="text-sm text-slate-700 mb-4">프로젝트 파일 저장 후 IndexedDB 캐시를 삭제하고 현재 프로젝트를 닫을지 확인합니다.</div>
        <div class="flex items-center justify-end gap-2">
          <button id="btnCancelConfirmAfterProjectExport" class="px-3 py-2 rounded bg-slate-100 hover:bg-slate-200 text-slate-800">취소</button>
          <button id="btnConfirmConfirmAfterProjectExport" class="px-3 py-2 rounded bg-blue-600 hover:bg-blue-500 text-white">확인</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    overlay.querySelector('#btnCancelConfirmAfterProjectExport')?.addEventListener('click', () => {
      if (confirmAfterProjectExportResolve) confirmAfterProjectExportResolve(false);
      closeConfirmAfterProjectExportModal();
    });
    overlay.querySelector('#btnConfirmConfirmAfterProjectExport')?.addEventListener('click', () => {
      if (confirmAfterProjectExportResolve) confirmAfterProjectExportResolve(true);
      closeConfirmAfterProjectExportModal();
    });
  }

  if (!document.getElementById('confirmAlsoSaveProjectModal')) {
    const overlay = document.createElement('div');
    overlay.id = 'confirmAlsoSaveProjectModal';
    overlay.className = 'hidden fixed inset-0 bg-black/50 z-[100] flex items-center justify-center px-4';
    overlay.innerHTML = `
      <div class="w-full max-w-md bg-white rounded-xl shadow-xl border border-slate-200 p-4">
        <div class="font-bold text-slate-900 mb-2">프로젝트도 함께 저장할까요?</div>
        <div class="text-sm text-slate-700 mb-4">PDF와 별도로 프로젝트(.pdfedit) 파일을 저장하면 원본 PDF와 편집 상태를 나중에 다시 불러올 수 있습니다.</div>
        <div class="flex items-center justify-end gap-2">
          <button id="btnPdfOnlyExport" class="px-3 py-2 rounded bg-slate-100 hover:bg-slate-200 text-slate-800">PDF만 저장</button>
          <button id="btnPdfAndProjectExport" class="px-3 py-2 rounded bg-blue-600 hover:bg-blue-500 text-white">함께 저장</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    overlay.querySelector('#btnPdfOnlyExport')?.addEventListener('click', () => {
      if (confirmAlsoSaveProjectResolve) confirmAlsoSaveProjectResolve(false);
      closeConfirmAlsoSaveProjectModal();
    });
    overlay.querySelector('#btnPdfAndProjectExport')?.addEventListener('click', () => {
      if (confirmAlsoSaveProjectResolve) confirmAlsoSaveProjectResolve(true);
      closeConfirmAlsoSaveProjectModal();
    });
  }
})();

dropzone.addEventListener('click', () => pdfFileInput.click());

btnOpenProjectFromDropzone?.addEventListener('click', (e) => {
  // dropzone 클릭 핸들러로 인해 PDF 탐색기까지 같이 뜨는 것을 방지합니다.
  e.stopPropagation();
  pdfProjectFileInput?.click();
});

// 사용자가 저장 이미지의 최대 가로(px)를 직접 설정할 수 있게 합니다.
// (단, A4 폭 미만은 강제로 clamp)
if (pageStorageMaxWidthInput) {
  pageStorageMaxWidthInput.min = String(A4_WIDTH_PX);
  pageStorageMaxWidthInput.value = String(PAGE_IMAGE_STORAGE_MAX_WIDTH);
  pageStorageMaxWidthInput.addEventListener('change', () => {
    const raw = pageStorageMaxWidthInput.value;
    const parsed = parseInt(raw, 10);
    const safe = !Number.isNaN(parsed) && parsed > 0 ? Math.max(parsed, A4_WIDTH_PX) : A4_WIDTH_PX;
    PAGE_IMAGE_STORAGE_MAX_WIDTH = safe;
    pageStorageMaxWidthInput.value = String(safe);
    try {
      localStorage.setItem(PAGE_IMAGE_STORAGE_MAX_WIDTH_KEY, String(safe));
    } catch (_e) {}
  });
}

dropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropzone.classList.add('border-blue-500', 'bg-blue-50/50');
});

dropzone.addEventListener('dragleave', () => {
  dropzone.classList.remove('border-blue-500', 'bg-blue-50/50');
});

dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('border-blue-500', 'bg-blue-50/50');
  if (e.dataTransfer.files && e.dataTransfer.files[0]) {
    const file = e.dataTransfer.files[0];
    const lowerName = (file.name || '').toLowerCase();
    const isPdf = file.type === 'application/pdf' || lowerName.endsWith('.pdf');
    const isProject = lowerName.endsWith('.pdfedit') || lowerName.endsWith('.pdfedit.gz');
    if (isPdf) {
      loadPdfFile(file);
    } else if (isProject) {
      loadProjectFile(file);
    } else {
      showToast('PDF 또는 프로젝트(.pdfedit) 파일만 지원합니다.', 'error');
    }
  }
});

pdfFileInput.addEventListener('change', (e) => {
  if (e.target.files && e.target.files[0]) {
    const file = e.target.files[0];
    const lowerName = (file.name || '').toLowerCase();
    const isPdf = file.type === 'application/pdf' || lowerName.endsWith('.pdf');
    const isProject = lowerName.endsWith('.pdfedit') || lowerName.endsWith('.pdfedit.gz');
    if (isPdf) loadPdfFile(file);
    else if (isProject) void loadProjectFile(file);
  }
});

pdfProjectFileInput?.addEventListener('change', (e) => {
  if (e.target.files && e.target.files[0]) {
    const file = e.target.files[0];
    void loadProjectFile(file);
  }
});

async function loadPdfFile(file) {
  showLoading('PDF 파일을 읽는 중...', '기존 IndexedDB를 초기화하고 저장합니다.');
  try {
    resetEditorToNoProject();
    await clearEditorSession();
    const arrayBuffer = await file.arrayBuffer();
    await openPdfDocument(arrayBuffer, {
      displayName: file.name,
      exportName: file.name.replace(/\.pdf$/i, '') + '_edited.pdf',
    });
    showToast('PDF 파일을 성공적으로 불러왔습니다.', 'success');
  } catch (error) {
    console.error('PDF Load Error:', error);
    showToast('PDF 파일을 읽는데 실패했습니다.', 'error');
  } finally {
    hideLoading();
  }
}

function decodeProjectMagicBytes() {
  return new TextEncoder().encode('PDFPAGEEDIT\0');
}

async function ungzipIfNeeded(arrayBuffer, shouldGunzip) {
  if (!shouldGunzip) return new Uint8Array(arrayBuffer);
  const input = new Uint8Array(arrayBuffer);

  // Prefer native DecompressionStream when available (faster, streaming).
  if (typeof DecompressionStream !== 'undefined') {
    const stream = new Blob([input]).stream().pipeThrough(new DecompressionStream('gzip'));
    const out = await new Response(stream).arrayBuffer();
    return new Uint8Array(out);
  }

  // Fallback for browsers/environments without DecompressionStream (e.g. Safari variants).
  try {
    return gunzipSync(input);
  } catch (_e) {
    throw new Error('Failed to unzip .pdfedit.gz (unsupported environment or invalid gzip).');
  }
}

async function loadProjectFile(file) {
  showLoading('프로젝트 파일을 불러오는 중...', '기존 IndexedDB를 초기화하고 복원합니다.');
  try {
    resetEditorToNoProject();
    await clearEditorSession();
    const arrayBuffer = await file.arrayBuffer();
    const lowerName = (file.name || '').toLowerCase();
    const shouldGunzip = lowerName.endsWith('.pdfedit.gz');

    const bytes = await ungzipIfNeeded(arrayBuffer, shouldGunzip);
    const magicBytes = decodeProjectMagicBytes();
    const magicLen = magicBytes.length;

    const magicOk =
      bytes.length >= magicLen &&
      magicBytes.every((b, i) => bytes[i] === b);

    if (!magicOk) {
      throw new Error('Invalid .pdfedit file (magic header mismatch).');
    }

    const jsonLen = new DataView(bytes.buffer, bytes.byteOffset + magicLen, 4).getUint32(0, true);
    const jsonStart = magicLen + 4;
    const jsonEnd = jsonStart + jsonLen;
    if (jsonEnd > bytes.length) throw new Error('Invalid .pdfedit file (json length out of bounds).');

    const jsonBytes = bytes.slice(jsonStart, jsonEnd);
    const jsonStr = new TextDecoder().decode(jsonBytes);
    const project = JSON.parse(jsonStr);

    const pdfBytes = bytes.slice(jsonEnd);
    if (!pdfBytes || pdfBytes.byteLength === 0) throw new Error('Invalid .pdfedit file (missing pdf bytes).');

    const pdfArrayBuffer = pdfBytes.buffer.slice(pdfBytes.byteOffset, pdfBytes.byteOffset + pdfBytes.byteLength);

    await openPdfDocument(pdfArrayBuffer, {
      displayName: project?.sourceFileName || file.name,
      exportName: project?.originalFileName || 'edited_document.pdf',
      restoredPageList: project?.pageList || [],
      restoredPageIndex: typeof project?.currentPageIndex === 'number' ? project.currentPageIndex : 0,
      skipSessionSave: true,
    });

    // openPdfDocument(restoredPageList)에서는 undo/redo용 in-memory baseline을 안 잡으므로 여기서 초기화합니다.
    pageHistoryEventsMap = new Map();
    pageHistoryPointerMap = new Map();
    pageHistoryBaselineMap = new Map(pageList.map((p) => [p.id, takePageSnapshot(p)]));
    pageList.forEach((p) => pageHistoryPointerMap.set(p.id, -1));

    // IndexedDB에도 복원된 상태를 저장 시도(공간 부족이면 화면 복원만 유지)
    try {
      await persistSessionNow();
    } catch (_e) {}

    showToast('프로젝트가 성공적으로 복원되었습니다.', 'success');
  } catch (error) {
    console.error('Project Import Error:', error);
    showToast('프로젝트 복원에 실패했습니다.', 'error');
  } finally {
    hideLoading();
  }
}

async function openPdfDocument(arrayBuffer, {
  displayName,
  exportName,
  restoredPageList = null,
  restoredPageIndex = 0,
  skipSessionSave = false,
} = {}) {
  sourceFileName = displayName;
  originalFileName = exportName;
  docName.textContent = displayName;

  clearPdfCaches();
  pdfSessionDirty = true;

  const loadedBytes = toUint8Array(arrayBuffer);

  // Keep an independent copy for IndexedDB; pdf.js may detach the buffer it receives.
  pdfSourceData = loadedBytes.slice();
  pdfDoc = await pdfjsLib.getDocument({
    data: loadedBytes.slice(),
    disableAutoFetch: true,
    disableFontFace: true,
    verbosity: 0,
  }).promise;

  if (restoredPageList && restoredPageList.length > 0) {
    pageList = normalizePageList(restoredPageList);
    currentPageIndex = clampPageIndex(restoredPageIndex, pageList.length);
  } else {
    pageList = Array.from({ length: pdfDoc.numPages }, (_, i) => ({
      id: 'page_' + Date.now() + '_' + (i + 1),
      originalPageIndex: i + 1,
      rotation: 0,
      crop: null,
      customImageDataUrl: null,
    }));
    currentPageIndex = 0;

    isRestoredSession = false;
    trustedBaselinePageIds = new Set(pageList.map((p) => p.id));

    // 신규 로드 시 undo/redo history는 비어있음(기준 스냅샷만 구성)
    pageHistoryEventsMap = new Map();
    pageHistoryPointerMap = new Map();
    pageHistoryBaselineMap = new Map(
      pageList.map((p) => [p.id, takePageSnapshot(p)])
    );
    pageList.forEach((p) => pageHistoryPointerMap.set(p.id, -1));
  }

  dropzone.classList.add('hidden');
  canvasWrapper.classList.remove('hidden');
  editorToolbar.classList.remove('hidden');

  btnExportPdf.disabled = false;
  btnExportPdf.classList.remove('opacity-50', 'cursor-not-allowed');
  if (btnExportProject) {
    btnExportProject.disabled = false;
    btnExportProject.classList.remove('opacity-50', 'cursor-not-allowed');
  }
  if (btnCloseProject) {
    btnCloseProject.disabled = false;
    btnCloseProject.classList.remove('opacity-50', 'cursor-not-allowed');
  }
  if (btnDeleteProject) {
    btnDeleteProject.disabled = false;
    btnDeleteProject.classList.remove('opacity-50', 'cursor-not-allowed');
  }
  btnCopyClipboard.disabled = false;
  btnCopyClipboard.classList.remove('opacity-50', 'cursor-not-allowed');

  renderSidebarThumbnails();

  const firstOriginalPage = pageList.find((page) => page.originalPageIndex != null);
  if (firstOriginalPage) {
    await getPdfPageCached(firstOriginalPage.originalPageIndex);
  }

  await renderCurrentPage();
  syncCurrentPageIndexCache();
  if (!skipSessionSave) {
    markSessionDirty({ pdf: true, immediate: true });
  }
}

function toUint8Array(data) {
  if (data instanceof Uint8Array) {
    return data.slice();
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function normalizePageList(pages) {
  return pages.map((page, index) => ({
    id: page.id || `page_restored_${index + 1}`,
    originalPageIndex: page.originalPageIndex ?? null,
    rotation: typeof page.rotation === 'number' ? page.rotation : 0,
    crop: page.crop ?? null,
    customImageDataUrl: page.customImageDataUrl ?? null,
  }));
}

function downscaleCanvas(canvas, maxWidth = PAGE_IMAGE_STORAGE_MAX_WIDTH) {
  if (canvas.width <= maxWidth) return canvas;

  const scale = maxWidth / canvas.width;
  const scaled = document.createElement('canvas');
  scaled.width = Math.max(1, Math.round(canvas.width * scale));
  scaled.height = Math.max(1, Math.round(canvas.height * scale));
  scaled.getContext('2d').drawImage(canvas, 0, 0, scaled.width, scaled.height);
  return scaled;
}

function canvasToStorageDataUrl(canvas) {
  return downscaleCanvas(canvas).toDataURL('image/jpeg', PAGE_IMAGE_STORAGE_QUALITY);
}

function hydratePageListFromSession(pages, pageAssets = new Map()) {
  return pages.map((page, index) => {
    const id = page.id || `page_restored_${index + 1}`;
    let customImageDataUrl = null;
    let customImageBlob = null;

    if (typeof page.customImageDataUrl === 'string' && page.customImageDataUrl) {
      customImageDataUrl = page.customImageDataUrl;
    } else if (page.hasCustomImage && pageAssets.has(id)) {
      const assetVal = pageAssets.get(id);
      if (assetVal instanceof Blob) {
        customImageBlob = assetVal;
        customImageDataUrl = URL.createObjectURL(assetVal);
        registerObjectUrl(customImageDataUrl);
      } else {
        customImageDataUrl = assetVal;
      }
    }

    return {
      id,
      originalPageIndex: page.originalPageIndex ?? null,
      rotation: typeof page.rotation === 'number' ? page.rotation : 0,
      crop: page.crop ?? null,
      customImageDataUrl,
      customImageBlob,
    };
  });
}

function applyPageHistoriesToPageList(
  pages,
  pageHistories = new Map(),
  pagePointers = new Map(),
  baselineMap = new Map()
) {
  if (!pages?.length) return;
  if (!pageHistories) return;

  for (const page of pages) {
    const events = pageHistories.get(page.id);

    const pointer =
      typeof pagePointers?.get(page.id) === 'number'
        ? pagePointers.get(page.id)
        : (Array.isArray(events) ? events.length : 0) - 1;

    const baseSnapshot = baselineMap?.get(page.id);
    if (baseSnapshot) applySnapshotToPage(page, baseSnapshot);

    if (!Array.isArray(events) || events.length === 0) continue;
    if (pointer < 0) continue;

    // undo/redo pointer에 맞게 이벤트 snapshot을 "앞부분만" 재적용합니다.
    for (let i = 0; i <= pointer && i < events.length; i++) {
      const snap = events[i]?.snapshot;
      if (!snap) continue;
      applySnapshotToPage(page, snap);
    }
  }
}

function takePageSnapshot(page) {
  return {
    originalPageIndex: page.originalPageIndex ?? null,
    rotation: typeof page.rotation === 'number' ? page.rotation : 0,
    crop: page.crop ?? null,
    customImageBlob: page.customImageBlob ?? dataUrlToBlob(page.customImageDataUrl) ?? null,
  };
}

function applySnapshotToPage(page, snapshot) {
  if (!page || !snapshot) return;
  if ('originalPageIndex' in snapshot) page.originalPageIndex = snapshot.originalPageIndex ?? null;
  if ('rotation' in snapshot) page.rotation = typeof snapshot.rotation === 'number' ? snapshot.rotation : 0;
  if ('crop' in snapshot) page.crop = snapshot.crop ?? null;

  // blob: URL은 revoke하지 않으면 세션 동안 누적될 수 있어, 교체 전에 이전 값을 정리합니다.
  const prevUrl = page.customImageDataUrl;
  if (prevUrl && typeof prevUrl === 'string' && prevUrl.startsWith('blob:')) {
    objectUrlRegistry.delete(prevUrl);
    try {
      URL.revokeObjectURL(prevUrl);
    } catch (_e) {}
  }

  if ('customImageBlob' in snapshot) {
    page.customImageBlob = snapshot.customImageBlob ?? null;
    if (page.customImageBlob) {
      const url = URL.createObjectURL(page.customImageBlob);
      registerObjectUrl(url);
      page.customImageDataUrl = url;
    } else {
      page.customImageDataUrl = null;
    }
  } else if ('customImageDataUrl' in snapshot) {
    // 레거시 히스토리(기존 저장 포맷) 호환: dataURL이 들어오면 Blob으로 변환합니다.
    page.customImageDataUrl = snapshot.customImageDataUrl ?? null;
    page.customImageBlob = page.customImageDataUrl
      ? dataUrlToBlob(page.customImageDataUrl) ?? null
      : null;
    if (page.customImageBlob) {
      const url = URL.createObjectURL(page.customImageBlob);
      registerObjectUrl(url);
      page.customImageDataUrl = url;
    }
  }
}

function updateUndoRedoButtons() {
  if (!btnUndoPage || !btnRedoPage) return;

  const applyBtnStyle = (btn, enabled) => {
    if (!btn) return;
    btn.classList.toggle('opacity-50', !enabled);
    btn.classList.toggle('cursor-not-allowed', !enabled);
    btn.classList.toggle('bg-slate-800', !enabled);
    btn.classList.toggle('hover:bg-slate-700', !enabled);
    btn.classList.toggle('text-slate-200', !enabled);

    btn.classList.toggle('bg-blue-600', enabled);
    btn.classList.toggle('hover:bg-blue-500', enabled);
    btn.classList.toggle('text-white', enabled);
  };

  if (currentPageIndex < 0 || currentPageIndex >= pageList.length) {
    btnUndoPage.disabled = true;
    btnRedoPage.disabled = true;
    applyBtnStyle(btnUndoPage, false);
    applyBtnStyle(btnRedoPage, false);
    return;
  }

  const pageId = pageList[currentPageIndex].id;
  const events = pageHistoryEventsMap.get(pageId) || [];
  const pointer =
    typeof pageHistoryPointerMap.get(pageId) === 'number'
      ? pageHistoryPointerMap.get(pageId)
      : events.length - 1;

  const canUndo = pointer >= 0;
  const canRedo = pointer < events.length - 1;

  btnUndoPage.disabled = !canUndo;
  btnRedoPage.disabled = !canRedo;

  applyBtnStyle(btnUndoPage, canUndo);
  applyBtnStyle(btnRedoPage, canRedo);
}

async function commitPageHistoryEvent(pageId, event) {
  const events = pageHistoryEventsMap.get(pageId) ? [...pageHistoryEventsMap.get(pageId)] : [];
  const pointer =
    typeof pageHistoryPointerMap.get(pageId) === 'number'
      ? pageHistoryPointerMap.get(pageId)
      : events.length - 1;

  // undo 이후 새로운 작업이면 redo 구간 제거
  const truncated = events.slice(0, pointer + 1);
  truncated.push(event);

  pageHistoryEventsMap.set(pageId, truncated);
  pageHistoryPointerMap.set(pageId, truncated.length - 1);

  const baselineSnapshot = pageHistoryBaselineMap.get(pageId);
  if (baselineSnapshot && (!isRestoredSession || trustedBaselinePageIds.has(pageId))) {
    await setPageHistoryBaseline(pageId, baselineSnapshot);
  }

  await setPageHistoryEvents(pageId, truncated);
  await setPageHistoryPointer(pageId, truncated.length - 1);
  updateUndoRedoButtons();
}

async function applyHistoryPointerToCurrentPage(pageId, pointer) {
  const pageIndex = pageList.findIndex((p) => p.id === pageId);
  if (pageIndex < 0) return;

  const page = pageList[pageIndex];
  if (pointer < 0) {
    const base = pageHistoryBaselineMap.get(pageId);
    applySnapshotToPage(page, base);
  } else {
    const events = pageHistoryEventsMap.get(pageId) || [];
    const snap = events[pointer]?.snapshot;
    applySnapshotToPage(page, snap);
  }

  renderSidebarThumbnails();
  await renderCurrentPage();
  updateUndoRedoButtons();
}

async function undoOnCurrentPage() {
  if (currentPageIndex < 0 || currentPageIndex >= pageList.length) return;
  const pageId = pageList[currentPageIndex].id;
  const events = pageHistoryEventsMap.get(pageId) || [];
  const pointer =
    typeof pageHistoryPointerMap.get(pageId) === 'number'
      ? pageHistoryPointerMap.get(pageId)
      : events.length - 1;

  if (pointer < 0) return;
  const nextPointer = pointer - 1;
  pageHistoryPointerMap.set(pageId, nextPointer);
  await setPageHistoryPointer(pageId, nextPointer);
  await applyHistoryPointerToCurrentPage(pageId, nextPointer);
}

async function redoOnCurrentPage() {
  if (currentPageIndex < 0 || currentPageIndex >= pageList.length) return;
  const pageId = pageList[currentPageIndex].id;
  const events = pageHistoryEventsMap.get(pageId) || [];
  const pointer =
    typeof pageHistoryPointerMap.get(pageId) === 'number'
      ? pageHistoryPointerMap.get(pageId)
      : events.length - 1;

  if (pointer >= events.length - 1) return;
  const nextPointer = pointer + 1;
  pageHistoryPointerMap.set(pageId, nextPointer);
  await setPageHistoryPointer(pageId, nextPointer);
  await applyHistoryPointerToCurrentPage(pageId, nextPointer);
}

function getPageIndexCacheKey(fileName = sourceFileName) {
  return `${PAGE_INDEX_CACHE_PREFIX}${fileName || 'unknown'}`;
}

function syncCurrentPageIndexCache() {
  if (pageList.length === 0 || currentPageIndex < 0) return;

  try {
    sessionStorage.setItem(getPageIndexCacheKey(), String(currentPageIndex));
  } catch (_error) {}
}

function readCurrentPageIndexCache(fileName) {
  try {
    const raw = sessionStorage.getItem(getPageIndexCacheKey(fileName));
    if (raw == null) return null;
    const index = parseInt(raw, 10);
    return Number.isNaN(index) ? null : index;
  } catch (_error) {
    return null;
  }
}

function clampPageIndex(index, pageCount) {
  if (pageCount <= 0) return 0;
  return Math.max(0, Math.min(index, pageCount - 1));
}

function resolveRestoredPageIndex(storedIndex, fileName, pageCount) {
  const idbIndex = clampPageIndex(
    typeof storedIndex === 'number' ? storedIndex : 0,
    pageCount
  );
  const cachedIndex = readCurrentPageIndexCache(fileName);
  if (cachedIndex == null) return idbIndex;

  const cached = clampPageIndex(cachedIndex, pageCount);
  if (idbIndex === cached) return idbIndex;
  if (idbIndex === 0 && cached > 0) return cached;

  return idbIndex;
}

function notifyPageIndexChanged() {
  syncCurrentPageIndexCache();
  markSessionDirty({ immediate: true });
}

function buildStateSnapshot({ externalizeImages = false } = {}) {
  if (pageList.length === 0) return null;

  const safePageIndex = clampPageIndex(currentPageIndex, pageList.length);

  return {
    pageList: pageList.map((page) => ({
      id: page.id,
      originalPageIndex: page.originalPageIndex ?? null,
      rotation: typeof page.rotation === 'number' ? page.rotation : 0,
      crop: page.crop ?? null,
      customImageDataUrl: externalizeImages ? null : (page.customImageDataUrl || null),
      hasCustomImage: Boolean(page.customImageDataUrl || page.customImageBlob),
    })),
    currentPageIndex: safePageIndex,
    savedAt: Date.now(),
  };
}

function buildPdfSnapshot() {
  if (!pdfSourceData || pdfSourceData.byteLength === 0) return null;

  try {
    return {
      sourceFileName,
      originalFileName,
      pdfData: pdfSourceData.slice(),
    };
  } catch (error) {
    console.error('PDF source buffer unavailable for session save:', error);
    return null;
  }
}

function markSessionDirty({ pdf = false, immediate = false } = {}) {
  if (pdf) pdfSessionDirty = true;
  sessionNeedsSave = true;

  if (immediate) {
    if (sessionSaveTimer) {
      clearTimeout(sessionSaveTimer);
      sessionSaveTimer = null;
    }
    void persistSessionNow();
    return;
  }

  if (sessionSaveTimer) clearTimeout(sessionSaveTimer);

  sessionSaveTimer = setTimeout(() => {
    sessionSaveTimer = null;
    void persistSessionNow();
  }, SESSION_SAVE_DELAY_MS);
}

async function persistSessionNow() {
  sessionNeedsSave = true;

  if (sessionSaveInFlight) {
    await sessionSaveInFlight;
  }

  sessionSaveInFlight = flushSessionSave();
  try {
    await sessionSaveInFlight;
  } finally {
    sessionSaveInFlight = null;
  }

  if (sessionNeedsSave) {
    await persistSessionNow();
  }
}

async function flushSessionSave() {
  do {
    sessionNeedsSave = false;

    const inlineSnapshot = buildStateSnapshot({ externalizeImages: true });
    if (!inlineSnapshot) {
      try {
        await clearEditorSession();
      } catch (error) {
        console.error('Session clear failed:', error);
      }
      return;
    }

    const assets = pageList
      .filter((page) => page.customImageDataUrl || page.customImageBlob)
      .map((page) => {
        const blob = page.customImageBlob ?? dataUrlToBlob(page.customImageDataUrl);
        return blob
          ? {
              id: page.id,
              imageBlob: blob,
              updatedAt: Date.now(),
            }
          : null;
      })
      .filter(Boolean);

    try {
      if (pdfSessionDirty) {
        const pdfSnapshot = buildPdfSnapshot();
        if (pdfSnapshot) {
          await saveEditorPdfRecord(pdfSnapshot);
          pdfSessionDirty = false;
        }
      }

      syncCurrentPageIndexCache();

      try {
        await saveEditorStateRecord(inlineSnapshot);
      } catch (error) {
        if (error?.name !== 'QuotaExceededError') throw error;

        await savePageAssetsIncremental(assets);
        await saveEditorStateRecord(buildStateSnapshot({ externalizeImages: true }));
      }
    } catch (error) {
      sessionNeedsSave = true;
      console.error('Session save failed:', error);
      if (error?.name === 'QuotaExceededError') {
        showToast('저장 공간이 부족해 작업 내용을 저장하지 못했습니다.', 'error');
      }
      throw error;
    }
  } while (sessionNeedsSave);
}

async function restoreEditorSession() {
  let session;
  try {
    session = await loadEditorSession();
  } catch (error) {
    console.error('Session load failed:', error);
    return false;
  }

  if (!session?.pdfData || !Array.isArray(session.pageList) || session.pageList.length === 0) {
    return false;
  }

  showLoading('이전 작업 복원 중...', '저장된 PDF와 편집 내용을 불러오고 있습니다.');
  try {
    const hydratedPageList = hydratePageListFromSession(
      session.pageList,
      session.pageAssets ?? new Map()
    );

    // undo/redo 기준 상태/포인터 초기화
    const restoredPageHistories = session.pageHistories ?? new Map();
    const restoredPageHistoryPointers = session.pageHistoryPointers ?? new Map();
    const restoredPageHistoryBaselines = session.pageHistoryBaselines ?? new Map();

    // 레거시 포맷 마이그레이션: 히스토리 스냅샷에 남아있는 customImageDataUrl을 Blob 기반으로 변환합니다.
    const migrateSnapshotCustomImage = (snapshot) => {
      if (!snapshot || typeof snapshot !== 'object') return;
      if (!('customImageDataUrl' in snapshot)) return;

      const dataUrl = snapshot.customImageDataUrl ?? null;
      delete snapshot.customImageDataUrl;
      snapshot.customImageBlob = dataUrl ? dataUrlToBlob(dataUrl) ?? null : null;
    };

    for (const [_pageId, events] of restoredPageHistories) {
      if (!Array.isArray(events)) continue;
      for (const ev of events) {
        if (ev?.snapshot) migrateSnapshotCustomImage(ev.snapshot);
      }
    }
    for (const [_pageId, baseSnap] of restoredPageHistoryBaselines) {
      migrateSnapshotCustomImage(baseSnap);
    }

    isRestoredSession = true;
    trustedBaselinePageIds = new Set(restoredPageHistoryBaselines.keys());

    pageHistoryEventsMap = restoredPageHistories;
    pageHistoryBaselineMap = new Map(
      hydratedPageList.map((p) => [
        p.id,
        restoredPageHistoryBaselines.get(p.id) ?? takePageSnapshot(p),
      ])
    );
    pageHistoryPointerMap = new Map(
      hydratedPageList.map((p) => [
        p.id,
        typeof restoredPageHistoryPointers.get(p.id) === 'number'
          ? restoredPageHistoryPointers.get(p.id)
          : (restoredPageHistories.get(p.id) || []).length - 1,
      ])
    );

    applyPageHistoriesToPageList(
      hydratedPageList,
      restoredPageHistories,
      pageHistoryPointerMap,
      pageHistoryBaselineMap
    );
    const restoredPageIndex = resolveRestoredPageIndex(
      session.currentPageIndex,
      session.sourceFileName,
      hydratedPageList.length
    );

    await openPdfDocument(session.pdfData, {
      displayName: session.sourceFileName || 'Restored document.pdf',
      exportName: session.originalFileName || 'edited_document.pdf',
      restoredPageList: hydratedPageList,
      restoredPageIndex,
      skipSessionSave: true,
    });
    pdfSessionDirty = false;
    syncCurrentPageIndexCache();
    // 마이그레이션된 히스토리 포맷(Blob 기반)을 IndexedDB에 다시 저장합니다.
    await persistSessionNow();
    showToast('이전 작업을 자동으로 복원했습니다.', 'info');
    return true;
  } catch (error) {
    console.error('Session restore failed:', error);
    try {
      await clearEditorSession();
    } catch (clearError) {
      console.error('Session clear after restore failure failed:', clearError);
    }
    showToast('이전 작업 복원에 실패했습니다.', 'error');
    return false;
  } finally {
    hideLoading();
  }
}

function getMainRenderScale(pdfPage) {
  const baseViewport = pdfPage.getViewport({ scale: 1 });
  const container = viewportContainer;
  if (!container) return 1.5;

  const padding = 48;
  const maxWidth = Math.max(container.clientWidth - padding, 320);
  const maxHeight = Math.max(container.clientHeight - padding, 240);
  const fitScale = Math.min(maxWidth / baseViewport.width, maxHeight / baseViewport.height);
  // 사용자 화면 렌더 품질을 높여(크롭/회전 시) 결과 이미지의 기준 해상도를 올립니다.
  return Math.min(Math.max(fitScale, 0.75), 2.0);
}

function clearPdfCaches() {
  pageCache.clear();
  thumbnailCache.clear();
}

function resetEditorToNoProject() {
  try {
    if (isCropMode) exitCropModeInternal({ revertDraft: false });
  } catch (_e) {}

  revokeRegisteredObjectUrls();

  // 메모리/상태만 비우고, IndexedDB는 건드리지 않습니다.
  pdfDoc = null;
  pdfSourceData = null;
  currentRenderTask = null;
  sourceFileName = '';
  originalFileName = 'edited_document.pdf';

  pageList = [];
  currentPageIndex = -1;

  isDraggingCrop = false;
  isResizingCrop = false;
  activeHandle = null;

  cropBoxDraftSnapshot = null;
  cropDraftDirty = false;

  pageHistoryEventsMap = new Map();
  pageHistoryPointerMap = new Map();
  pageHistoryBaselineMap = new Map();

  pdfSessionDirty = false;
  sessionNeedsSave = false;

  clearPdfCaches();
  void renderCurrentPage();
}

async function deleteIndexedDbProjectAndReset() {
  showLoading('프로젝트 삭제 중...', 'IndexedDB에 저장된 데이터를 지우고 있습니다.');
  try {
    await clearEditorSession(); // IndexedDB 삭제
    showToast('프로젝트가 삭제되었습니다.', 'success');
  } catch (err) {
    console.error('Delete Project Error:', err);
    showToast('프로젝트 삭제에 실패했습니다.', 'error');
    throw err;
  } finally {
    hideLoading();
  }

  resetEditorToNoProject();
}

async function getPdfPageCached(pageNum) {
  if (pageCache.has(pageNum)) {
    return pageCache.get(pageNum);
  }
  const page = await pdfDoc.getPage(pageNum);
  pageCache.set(pageNum, page);
  return page;
}

async function renderCurrentPage() {
  if (currentPageIndex < 0 || currentPageIndex >= pageList.length) {
    if (pageList.length === 0) {
      canvasWrapper.classList.add('hidden');
      editorToolbar.classList.add('hidden');
      emptySidebarState.classList.remove('hidden');
      dropzone.classList.remove('hidden');
      docName.textContent = 'Select a file';
      btnExportPdf.disabled = true;
      btnExportPdf.classList.add('opacity-50', 'cursor-not-allowed');
      if (btnExportProject) {
        btnExportProject.disabled = true;
        btnExportProject.classList.add('opacity-50', 'cursor-not-allowed');
      }
      btnCopyClipboard.disabled = true;
      btnCopyClipboard.classList.add('opacity-50', 'cursor-not-allowed');
      if (btnUndoPage) btnUndoPage.disabled = true;
      if (btnRedoPage) btnRedoPage.disabled = true;
      if (btnCloseProject) btnCloseProject.disabled = true;
      if (btnDeleteProject) btnDeleteProject.disabled = true;
      renderSidebarThumbnails();
      return;
    }
    currentPageIndex = 0;
  }

  const item = pageList[currentPageIndex];

  currentPageNum.max = pageList.length;
  if (document.activeElement !== currentPageNum) {
    currentPageNum.value = currentPageIndex + 1;
  }
  currentPageNum.disabled = false;
  totalPagesNum.textContent = pageList.length;
  pageCount.textContent = pageList.length;
  btnPrevPage.disabled = currentPageIndex === 0;
  btnNextPage.disabled = currentPageIndex === pageList.length - 1;

  const currentRot = normalizeRotation(item.rotation);
  if (item.rotation !== currentRot) {
    item.rotation = currentRot;
  }
  rotationRange.value = currentRot;
  if (rotationInput) rotationInput.value = currentRot;
  updateApplyRotationButtonVisibility(currentRot);

  updateSidebarActiveHighlight();
  scrollThumbnailIntoView(currentPageIndex);
  updateUndoRedoButtons();

  const seq = ++renderSeq;

  pdfCanvas.classList.add('page-loading-blur');
  showPageLoadingToast();

  const canvasLoader = document.getElementById('canvasLoader');
  if (canvasLoader) canvasLoader.classList.remove('hidden');

  if (item.customImageDataUrl) {
    if (currentRenderTask) {
      try { currentRenderTask.cancel(); } catch (e) {}
      currentRenderTask = null;
    }

    const img = new Image();
    img.onload = () => {
      if (seq !== renderSeq) return;
      pdfCanvas.width = img.width;
      pdfCanvas.height = img.height;
      const ctx = pdfCanvas.getContext('2d');
      ctx.clearRect(0, 0, img.width, img.height);
      ctx.drawImage(img, 0, 0);
      applyCanvasRotation(item.rotation);
      if (isCropMode) updateCropOverlayPosition();
      if (canvasLoader) canvasLoader.classList.add('hidden');
      pdfCanvas.classList.remove('page-loading-blur');
      hidePageLoadingToast();
    };
    img.src = item.customImageDataUrl;
  } else {
    if (currentRenderTask) {
      try {
        currentRenderTask.cancel();
      } catch (e) {}
      currentRenderTask = null;
    }

    try {
      const pdfPage = await getPdfPageCached(item.originalPageIndex);
      const viewport = pdfPage.getViewport({ scale: getMainRenderScale(pdfPage) });

      pdfCanvas.width = viewport.width;
      pdfCanvas.height = viewport.height;

      const ctx = pdfCanvas.getContext('2d');
      const renderContext = {
        canvasContext: ctx,
        viewport,
        intent: 'display',
      };

      const renderTask = pdfPage.render(renderContext);
      currentRenderTask = renderTask;

      await renderTask.promise;
      applyCanvasRotation(item.rotation);
      if (isCropMode) updateCropOverlayPosition();
    } catch (error) {
      if (error && error.name === 'RenderingCancelledException') {
        return;
      }
      console.error('Page render error:', error);
    } finally {
      if (seq === renderSeq) {
        if (canvasLoader) canvasLoader.classList.add('hidden');
        pdfCanvas.classList.remove('page-loading-blur');
        hidePageLoadingToast();
      }
    }
  }
}

function applyCanvasRotation(deg) {
  pdfCanvas.style.transform = `rotate(${deg}deg)`;
  pdfCanvas.style.transition = 'transform 0.15s ease-out';
}

function ensureThumbnailVirtualList() {
  if (!thumbnailVirtualList) {
    thumbnailVirtualList = document.createElement('div');
    thumbnailVirtualList.id = 'thumbnailVirtualList';
    thumbnailVirtualList.className = 'relative w-full';
    thumbnailContainer.appendChild(thumbnailVirtualList);
    thumbnailContainer.addEventListener('scroll', onThumbnailScroll, { passive: true });
  }
  return thumbnailVirtualList;
}

function onThumbnailScroll() {
  if (virtualScrollRaf !== null) return;
  virtualScrollRaf = requestAnimationFrame(() => {
    virtualScrollRaf = null;
    renderVisibleThumbnails();
  });
}

function updateThumbCardAppearance(card, index) {
  const isActive = index === currentPageIndex;
  card.className = `group absolute left-0 right-0 bg-white border-2 rounded-xl p-2 cursor-pointer transition shadow-xs flex flex-col items-center ${
    isActive ? 'border-blue-600 ring-2 ring-blue-100 bg-blue-50/20' : 'border-slate-200 hover:border-slate-300'
  }`;
}

function createThumbCard(index) {
  const item = pageList[index];
  const thumbCard = document.createElement('div');
  thumbCard.dataset.index = String(index);
  updateThumbCardAppearance(thumbCard, index);

  const thumbCanvas = document.createElement('canvas');
  thumbCanvas.className = 'w-full h-auto rounded border border-slate-100 bg-white object-contain max-h-36';

  const infoBar = document.createElement('div');
  infoBar.className = 'w-full mt-2 flex items-center justify-between text-xs text-slate-500 font-medium px-1';

  const pageLabel = document.createElement('span');
  pageLabel.className = 'flex items-center gap-1';

  const pageNumSpan = document.createElement('span');
  pageNumSpan.className = 'font-bold text-slate-700';
  pageNumSpan.textContent = index + 1;
  pageLabel.appendChild(pageNumSpan);

  const rotBadge = document.createElement('span');
  rotBadge.className = `rot-badge text-[10px] text-blue-600 bg-blue-50 px-1 rounded ${isRotationZero(item.rotation) ? 'hidden' : ''}`;
  rotBadge.textContent = formatRotationLabel(item.rotation);
  pageLabel.appendChild(rotBadge);

  if (item.customImageDataUrl) {
    const cropBadge = document.createElement('span');
    cropBadge.className = 'text-[10px] text-emerald-600 bg-emerald-50 px-1 rounded';
    cropBadge.textContent = 'Cropped';
    pageLabel.appendChild(cropBadge);
  }

  const actions = document.createElement('div');
  actions.className = 'flex items-center space-x-1 opacity-80 group-hover:opacity-100';

  if (index > 0) {
    const btnUp = document.createElement('button');
    btnUp.className = 'p-1 hover:text-blue-600';
    btnUp.title = 'Move up';
    btnUp.innerHTML = '<i class="fa-solid fa-arrow-up text-[11px]"></i>';
    btnUp.onclick = (e) => { e.stopPropagation(); movePage(index, index - 1); };
    actions.appendChild(btnUp);
  }
  if (index < pageList.length - 1) {
    const btnDown = document.createElement('button');
    btnDown.className = 'p-1 hover:text-blue-600';
    btnDown.title = 'Move down';
    btnDown.innerHTML = '<i class="fa-solid fa-arrow-down text-[11px]"></i>';
    btnDown.onclick = (e) => { e.stopPropagation(); movePage(index, index + 1); };
    actions.appendChild(btnDown);
  }

  const btnDel = document.createElement('button');
  btnDel.className = 'p-1 hover:text-rose-600 text-slate-400';
  btnDel.title = 'Delete page';
  btnDel.innerHTML = '<i class="fa-solid fa-trash-can text-[11px]"></i>';
  btnDel.onclick = (e) => { e.stopPropagation(); deletePage(index); };
  actions.appendChild(btnDel);

  infoBar.appendChild(pageLabel);
  infoBar.appendChild(actions);
  thumbCard.appendChild(thumbCanvas);
  thumbCard.appendChild(infoBar);

  thumbCard.addEventListener('click', () => {
    clearPageInputDebounce();
    if (currentPageIndex === index) return;
    currentPageIndex = index;
    renderCurrentPage();
    notifyPageIndexChanged();
  });

  return thumbCard;
}

function renderVisibleThumbnails() {
  const list = thumbnailVirtualList;
  if (!list || pageList.length === 0) return;

  const scrollTop = thumbnailContainer.scrollTop;
  const viewHeight = thumbnailContainer.clientHeight;
  const startIndex = Math.max(0, Math.floor(scrollTop / THUMB_ITEM_HEIGHT) - THUMB_OVERSCAN);
  const endIndex = Math.min(
    pageList.length - 1,
    Math.ceil((scrollTop + viewHeight) / THUMB_ITEM_HEIGHT) + THUMB_OVERSCAN
  );

  const existingCards = new Map();
  list.querySelectorAll('[data-index]').forEach((card) => {
    existingCards.set(parseInt(card.dataset.index, 10), card);
  });

  const visibleIndices = new Set();
  for (let i = startIndex; i <= endIndex; i++) visibleIndices.add(i);

  existingCards.forEach((card, index) => {
    if (!visibleIndices.has(index)) card.remove();
  });

  for (let i = startIndex; i <= endIndex; i++) {
    let card = existingCards.get(i);
    if (!card) {
      card = createThumbCard(i);
      list.appendChild(card);
    } else {
      updateThumbCardAppearance(card, i);
      const item = pageList[i];
      const rotBadge = card.querySelector('.rot-badge');
      if (rotBadge) {
        if (isRotationZero(item.rotation)) {
          rotBadge.classList.add('hidden');
        } else {
          rotBadge.textContent = formatRotationLabel(item.rotation);
          rotBadge.classList.remove('hidden');
        }
      }
      const canvas = card.querySelector('canvas');
      if (canvas) canvas.style.transform = `rotate(${item.rotation}deg)`;
    }

    card.style.top = `${i * THUMB_ITEM_HEIGHT}px`;
    card.style.height = `${THUMB_ITEM_HEIGHT - 12}px`;

    const canvas = card.querySelector('canvas');
    if (canvas && !canvas.dataset.rendered) {
      canvas.dataset.rendered = 'true';
      renderThumbnailCanvas(pageList[i], canvas);
    }
  }
}

function scrollThumbnailIntoView(index) {
  if (!thumbnailVirtualList || pageList.length === 0 || index < 0) return;

  const top = index * THUMB_ITEM_HEIGHT;
  const bottom = top + THUMB_ITEM_HEIGHT;
  const { scrollTop, clientHeight } = thumbnailContainer;

  if (top < scrollTop) {
    thumbnailContainer.scrollTop = top;
  } else if (bottom > scrollTop + clientHeight) {
    thumbnailContainer.scrollTop = bottom - clientHeight;
  }

  renderVisibleThumbnails();
}

function updateSidebarActiveHighlight() {
  if (!thumbnailVirtualList) return;
  thumbnailVirtualList.querySelectorAll('[data-index]').forEach((card) => {
    const idx = parseInt(card.dataset.index, 10);
    updateThumbCardAppearance(card, idx);
  });
}

function renderSidebarThumbnails() {
  if (pageList.length === 0) {
    emptySidebarState.classList.remove('hidden');
    if (thumbnailVirtualList) {
      thumbnailVirtualList.classList.add('hidden');
      thumbnailVirtualList.innerHTML = '';
    }
    return;
  }

  emptySidebarState.classList.add('hidden');
  const list = ensureThumbnailVirtualList();
  list.classList.remove('hidden');
  list.style.height = `${pageList.length * THUMB_ITEM_HEIGHT}px`;
  list.innerHTML = '';
  renderVisibleThumbnails();
}

async function renderThumbnailCanvas(item, canvas) {
  if (item.customImageDataUrl) {
    const img = new Image();
    img.onload = () => {
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      canvas.style.transform = `rotate(${item.rotation}deg)`;
    };
    img.src = item.customImageDataUrl;
    return;
  }

  if (thumbnailCache.has(item.originalPageIndex)) {
    const cachedDataUrl = thumbnailCache.get(item.originalPageIndex);
    const img = new Image();
    img.onload = () => {
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      canvas.style.transform = `rotate(${item.rotation}deg)`;
    };
    img.src = cachedDataUrl;
    return;
  }

  if (pdfDoc && item.originalPageIndex) {
    try {
      const page = await getPdfPageCached(item.originalPageIndex);
      const viewport = page.getViewport({ scale: 0.3 });
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const ctx = canvas.getContext('2d');
      await page.render({ canvasContext: ctx, viewport, intent: 'display' }).promise;
      canvas.style.transform = `rotate(${item.rotation}deg)`;

      const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
      thumbnailCache.set(item.originalPageIndex, dataUrl);
    } catch (err) {
      console.error('Thumbnail render error:', err);
    }
  }
}

function normalizeRotation(deg) {
  let d = Math.round(deg * 10) / 10;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return Math.round(d * 10) / 10;
}

function formatRotationLabel(deg) {
  const norm = normalizeRotation(deg);
  return Number.isInteger(norm) ? `${norm}°` : `${norm.toFixed(1)}°`;
}

function isRotationZero(deg) {
  return normalizeRotation(deg) === 0;
}

function setPageRotation(deg) {
  if (currentPageIndex < 0 || currentPageIndex >= pageList.length) return;
  const normDeg = normalizeRotation(deg);
  pageList[currentPageIndex].rotation = normDeg;
  rotationRange.value = normDeg;
  if (rotationInput) rotationInput.value = normDeg;
  applyCanvasRotation(normDeg);
  updateSidebarThumbnailRotation(currentPageIndex, normDeg);
  updateApplyRotationButtonVisibility(normDeg);
  markSessionDirty();
}

function updateApplyRotationButtonVisibility(deg) {
  if (!btnApplyRotationToPage) return;
  if (isRotationZero(deg)) {
    btnApplyRotationToPage.disabled = true;
    btnApplyRotationToPage.classList.add('opacity-50', 'cursor-not-allowed');
  } else {
    btnApplyRotationToPage.disabled = false;
    btnApplyRotationToPage.classList.remove('opacity-50', 'cursor-not-allowed');
  }
}

rotationRange.addEventListener('input', (e) => {
  setPageRotation(parseFloat(e.target.value));
});

if (rotationInput) {
  rotationInput.addEventListener('input', (e) => {
    let val = parseFloat(e.target.value);
    if (isNaN(val)) val = 0;
    setPageRotation(val);
  });
}

btnRotateCw30.addEventListener('click', () => {
  setPageRotation(pageList[currentPageIndex].rotation + 30);
});

btnRotateCcw30.addEventListener('click', () => {
  setPageRotation(pageList[currentPageIndex].rotation - 30);
});

btnRotateCw1.addEventListener('click', () => {
  setPageRotation(pageList[currentPageIndex].rotation + 1);
});

btnRotateCcw1.addEventListener('click', () => {
  setPageRotation(pageList[currentPageIndex].rotation - 1);
});

btnRotateCw01.addEventListener('click', () => {
  setPageRotation(pageList[currentPageIndex].rotation + 0.1);
});

btnRotateCcw01.addEventListener('click', () => {
  setPageRotation(pageList[currentPageIndex].rotation - 0.1);
});

btnResetRotate.addEventListener('click', () => {
  setPageRotation(0);
});

btnApplyRotationToPage.addEventListener('click', async () => {
  await applyRotationToCurrentPage();
});

function updateSidebarThumbnailRotation(index, deg) {
  const card = thumbnailVirtualList?.querySelector(`[data-index="${index}"]`);
  if (card) {
    const canvas = card.querySelector('canvas');
    if (canvas) canvas.style.transform = `rotate(${deg}deg)`;

    const badge = card.querySelector('.rot-badge');
    if (badge) {
      if (!isRotationZero(deg)) {
        badge.textContent = formatRotationLabel(deg);
        badge.classList.remove('hidden');
      } else {
        badge.classList.add('hidden');
      }
    }
  }
}

btnToggleCrop.addEventListener('click', () => {
  if (!isCropMode) {
    enterCropMode();
    return;
  }
  void attemptExitCropModeWithConfirm();
});

function applyCropPreset(presetKey) {
  const preset = CROP_PRESETS[presetKey];
  if (!preset) return;

  cropBox = { ...preset };
  updateCropOverlayPosition();

  cropPresetGroup.querySelectorAll('[data-crop-preset]').forEach((btn) => {
    const isActive = btn.dataset.cropPreset === presetKey;
    btn.classList.toggle('bg-blue-100', isActive);
    btn.classList.toggle('border-blue-400', isActive);
    btn.classList.toggle('text-blue-700', isActive);
    btn.classList.toggle('bg-slate-100', !isActive);
    btn.classList.toggle('border-slate-200', !isActive);
    btn.classList.toggle('text-slate-700', !isActive);
  });
}

cropPresetGroup.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-crop-preset]');
  if (!btn) return;
  applyCropPreset(btn.dataset.cropPreset);
});

function updateCropOverlayPosition() {
  const cw = pdfCanvas.offsetWidth;
  const ch = pdfCanvas.offsetHeight;
  const cl = pdfCanvas.offsetLeft;
  const ct = pdfCanvas.offsetTop;

  const left = cl + cropBox.x * cw;
  const top = ct + cropBox.y * ch;
  const width = cropBox.w * cw;
  const height = cropBox.h * ch;

  cropOverlay.style.left = `${left}px`;
  cropOverlay.style.top = `${top}px`;
  cropOverlay.style.width = `${width}px`;
  cropOverlay.style.height = `${height}px`;

  const pxW = Math.round(cropBox.w * pdfCanvas.width);
  const pxH = Math.round(cropBox.h * pdfCanvas.height);
  cropSizeLabel.textContent = `${pxW} x ${pxH} px`;

  // cropDraftDirty 판단은 cropBox 변경이 있을 때마다 갱신합니다.
  updateCropDraftDirty();
}

function cropBoxesEqual(a, b, eps = 1e-6) {
  if (!a || !b) return false;
  return (
    Math.abs(a.x - b.x) < eps &&
    Math.abs(a.y - b.y) < eps &&
    Math.abs(a.w - b.w) < eps &&
    Math.abs(a.h - b.h) < eps
  );
}

function updateCropDraftDirty() {
  if (!isCropMode) return;
  if (!cropBoxDraftSnapshot) {
    cropDraftDirty = false;
    return;
  }
  cropDraftDirty = !cropBoxesEqual(cropBox, cropBoxDraftSnapshot);
}

function enterCropMode() {
  if (isCropMode) return;
  isCropMode = true;

  cropBtnText.textContent = 'Cancel Crop';

  btnToggleCrop.classList.add('bg-slate-300');
  btnToggleCrop.classList.remove('bg-slate-100');
  btnToggleCrop.classList.add('hover:bg-slate-500');
  btnToggleCrop.classList.remove('hover:bg-blue-50');
  btnToggleCrop.classList.add('text-white');
  btnToggleCrop.classList.remove('text-slate-700');

  cropOverlay.classList.remove('hidden');
  cropPresetGroup.classList.remove('hidden');
  cropPresetGroup.classList.add('flex');
  btnApplyCropToPage.classList.remove('hidden');
  btnAddCroppedPage.classList.remove('hidden');

  pdfCanvas.classList.remove(PDF_CANVAS_MAX_H_DEFAULT_CLASS);
  pdfCanvas.classList.add(PDF_CANVAS_MAX_H_CROP_CLASS);

  // Default preset으로 draft 시작
  cropBoxDraftSnapshot = null;
  cropDraftDirty = false;
  applyCropPreset('center80');
  cropBoxDraftSnapshot = { ...cropBox };
  cropDraftDirty = false;
}

function exitCropModeInternal({ revertDraft = false } = {}) {
  if (!isCropMode) return;
  isCropMode = false;

  // revertDraft: cropBox 변경을 버리고 snapshot 상태로 복원
  if (revertDraft && cropBoxDraftSnapshot) {
    cropBox = { ...cropBoxDraftSnapshot };
    updateCropOverlayPosition();
  }

  cropBtnText.textContent = '영역 크롭 모드';

  btnToggleCrop.classList.remove('bg-slate-300');
  btnToggleCrop.classList.add('bg-slate-100');
  btnToggleCrop.classList.remove('hover:bg-slate-500');
  btnToggleCrop.classList.add('hover:bg-blue-50');
  btnToggleCrop.classList.remove('text-white');
  btnToggleCrop.classList.add('text-slate-700');

  cropOverlay.classList.add('hidden');
  cropPresetGroup.classList.add('hidden');
  cropPresetGroup.classList.remove('flex');

  btnApplyCropToPage.classList.add('hidden');
  btnAddCroppedPage.classList.add('hidden');

  pdfCanvas.classList.remove(PDF_CANVAS_MAX_H_CROP_CLASS);
  pdfCanvas.classList.add(PDF_CANVAS_MAX_H_DEFAULT_CLASS);

  cropBoxDraftSnapshot = null;
  cropDraftDirty = false;
}

async function attemptExitCropModeWithConfirm() {
  if (!isCropMode) return;
  if (!cropDraftDirty) {
    exitCropModeInternal({ revertDraft: false });
    return;
  }

  const confirmed = await openConfirmCropExitModal();
  if (!confirmed) return;
  exitCropModeInternal({ revertDraft: true });
}

cropOverlay.addEventListener('mousedown', (e) => {
  e.stopPropagation();
  e.preventDefault();

  const handle = e.target.closest('.crop-handle');
  if (handle) {
    isResizingCrop = true;
    activeHandle = handle.classList[1];
  } else {
    isDraggingCrop = true;
  }

  dragStartX = e.clientX;
  dragStartY = e.clientY;
  cropStartBox = { ...cropBox };

  document.addEventListener('mousemove', onCropMouseMove);
  document.addEventListener('mouseup', onCropMouseUp);
});

function onCropMouseMove(e) {
  if (!isDraggingCrop && !isResizingCrop) return;

  const cw = pdfCanvas.offsetWidth;
  const ch = pdfCanvas.offsetHeight;
  if (cw === 0 || ch === 0) return;

  const dx = (e.clientX - dragStartX) / cw;
  const dy = (e.clientY - dragStartY) / ch;

  if (isDraggingCrop) {
    let nx = cropStartBox.x + dx;
    let ny = cropStartBox.y + dy;
    nx = Math.max(0, Math.min(1 - cropStartBox.w, nx));
    ny = Math.max(0, Math.min(1 - cropStartBox.h, ny));
    cropBox.x = nx;
    cropBox.y = ny;
  } else if (isResizingCrop) {
    let { x, y, w, h } = cropStartBox;
    if (activeHandle.includes('e')) w = Math.max(0.05, Math.min(1 - x, w + dx));
    if (activeHandle.includes('s')) h = Math.max(0.05, Math.min(1 - y, h + dy));
    if (activeHandle.includes('w')) {
      const nw = Math.max(0.05, w - dx);
      x = Math.max(0, x + (w - nw));
      w = nw;
    }
    if (activeHandle.includes('n')) {
      const nh = Math.max(0.05, h - dy);
      y = Math.max(0, y + (h - nh));
      h = nh;
    }
    cropBox = { x, y, w, h };
  }

  updateCropOverlayPosition();
}

function onCropMouseUp() {
  isDraggingCrop = false;
  isResizingCrop = false;
  document.removeEventListener('mousemove', onCropMouseMove);
  document.removeEventListener('mouseup', onCropMouseUp);
}

function getCropStepDelta(axis, pixelStep = 10) {
  const basis = axis === 'x' ? pdfCanvas.offsetWidth : pdfCanvas.offsetHeight;
  if (!basis) return 0;
  return pixelStep / basis;
}

function moveCropBoxByPixels(deltaX, deltaY) {
  if (!isCropMode) return;

  const stepX = getCropStepDelta('x', deltaX);
  const stepY = getCropStepDelta('y', deltaY);
  const nextX = Math.max(0, Math.min(1 - cropBox.w, cropBox.x + stepX));
  const nextY = Math.max(0, Math.min(1 - cropBox.h, cropBox.y + stepY));

  cropBox = {
    ...cropBox,
    x: nextX,
    y: nextY,
  };
  updateCropOverlayPosition();
}

function resizeCropBoxByPixels(deltaWidth, deltaHeight) {
  if (!isCropMode) return;

  const stepW = getCropStepDelta('x', deltaWidth);
  const stepH = getCropStepDelta('y', deltaHeight);
  const nextW = Math.max(0.05, Math.min(1 - cropBox.x, cropBox.w + stepW));
  const nextH = Math.max(0.05, Math.min(1 - cropBox.y, cropBox.h + stepH));

  cropBox = {
    ...cropBox,
    w: nextW,
    h: nextH,
  };
  updateCropOverlayPosition();
}

function getRotationShortcutStep(event) {
  if (event.altKey) return 0.1;
  if (event.shiftKey) return 10;
  return 1;
}

function handleCropShortcut(event) {
  if (!isCropMode) return false;

  if (event.key === 'Enter') {
    event.preventDefault();
    void btnApplyCropToPage.click();
    return true;
  }

  if (event.key === 'a' || event.key === 'A') {
    event.preventDefault();
    applyCropPreset('leftHalf');
    return true;
  }

  if (event.key === 's' || event.key === 'S') {
    event.preventDefault();
    applyCropPreset('center80');
    return true;
  }

  const cropStepPx = 10;
  if (event.altKey || event.shiftKey) {
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      resizeCropBoxByPixels(-cropStepPx, 0);
      return true;
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      resizeCropBoxByPixels(cropStepPx, 0);
      return true;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      resizeCropBoxByPixels(0, -cropStepPx);
      return true;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      resizeCropBoxByPixels(0, cropStepPx);
      return true;
    }
  }

  if (event.key === 'ArrowLeft') {
    event.preventDefault();
    moveCropBoxByPixels(-cropStepPx, 0);
    return true;
  }
  if (event.key === 'ArrowRight') {
    event.preventDefault();
    moveCropBoxByPixels(cropStepPx, 0);
    return true;
  }
  if (event.key === 'ArrowUp') {
    event.preventDefault();
    moveCropBoxByPixels(0, -cropStepPx);
    return true;
  }
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    moveCropBoxByPixels(0, cropStepPx);
    return true;
  }

  return false;
}

function handleRotationShortcut(event) {
  if (event.key !== 'q' && event.key !== 'Q' && event.key !== 'e' && event.key !== 'E' && event.key !== 'Enter') {
    return false;
  }

  if (event.key === 'Enter') {
    if (isCropMode) return false;
    if (currentPageIndex < 0 || currentPageIndex >= pageList.length) return false;
    if (isRotationZero(pageList[currentPageIndex].rotation)) return false;
    event.preventDefault();
    void btnApplyRotationToPage.click();
    return true;
  }

  const sign = event.key.toLowerCase() === 'q' ? -1 : 1;
  const step = getRotationShortcutStep(event);
  event.preventDefault();
  setPageRotation(pageList[currentPageIndex].rotation + sign * step);
  return true;
}

btnAddCroppedPage.addEventListener('click', async () => {
  showLoading('크롭 영역 추출 중...', '선택한 영역을 새 페이지로 생성하고 있습니다.');
  try {
    const croppedDataUrl = await generateCroppedImageDataUrl();
    const croppedBlob = dataUrlToBlob(croppedDataUrl);

    const newPageItem = {
      id: 'page_crop_' + Date.now(),
      originalPageIndex: null,
      rotation: 0,
      crop: null,
      customImageDataUrl: croppedDataUrl,
      customImageBlob: croppedBlob,
    };

    pageList.splice(currentPageIndex + 1, 0, newPageItem);
    currentPageIndex++;

    pageHistoryEventsMap.set(newPageItem.id, []);
    pageHistoryPointerMap.set(newPageItem.id, -1);
    pageHistoryBaselineMap.set(newPageItem.id, takePageSnapshot(newPageItem));
    trustedBaselinePageIds.add(newPageItem.id);

    await commitPageHistoryEvent(newPageItem.id, {
      type: 'crop_add',
      ts: Date.now(),
      snapshot: {
        originalPageIndex: null,
        rotation: 0,
        crop: null,
        customImageBlob: croppedBlob,
      },
    });

    exitCropModeInternal({ revertDraft: false });

    await renderSidebarThumbnails();
    await renderCurrentPage();
    await persistSessionNow();
    showToast('새 크롭 페이지가 추가되었습니다!', 'success');
  } catch (err) {
    console.error(err);
    showToast('크롭 페이지 생성에 실패했습니다.', 'error');
  } finally {
    hideLoading();
  }
});

btnApplyCropToPage.addEventListener('click', async () => {
  if (currentPageIndex < 0 || currentPageIndex >= pageList.length) return;

  showLoading('크롭 적용 중...', '선택한 영역을 현재 페이지에 반영하고 있습니다.');
  try {
    const croppedDataUrl = await generateCroppedImageDataUrl();
    const croppedBlob = dataUrlToBlob(croppedDataUrl);
    const currentItem = pageList[currentPageIndex];
    const pageId = currentItem.id;

    pageList[currentPageIndex] = {
      ...currentItem,
      originalPageIndex: null,
      rotation: 0,
      crop: null,
      customImageDataUrl: croppedDataUrl,
      customImageBlob: croppedBlob,
    };

    await commitPageHistoryEvent(pageId, {
      type: 'crop_apply',
      ts: Date.now(),
      snapshot: {
        originalPageIndex: null,
        rotation: 0,
        crop: null,
        customImageBlob: croppedBlob,
      },
    });

    exitCropModeInternal({ revertDraft: false });

    await renderSidebarThumbnails();
    await renderCurrentPage();
    await persistSessionNow();
    showToast('크롭이 현재 페이지에 적용되었습니다.', 'success');
  } catch (err) {
    console.error(err);
    showToast('크롭 적용에 실패했습니다.', 'error');
  } finally {
    hideLoading();
  }
});

async function applyRotationToCurrentPage() {
  if (currentPageIndex < 0 || currentPageIndex >= pageList.length) return;

  const item = pageList[currentPageIndex];
  const pageId = item.id;
  if (isRotationZero(item.rotation)) return;

  showLoading('회전 적용 중...', '현재 페이지에 회전을 반영하고 있습니다.');
  try {
    const canvas = await renderPageToCanvas(item, PAGE_IMAGE_STORAGE_RENDER_SCALE);
    const dataUrl = canvasToStorageDataUrl(canvas);
    const blob = dataUrlToBlob(dataUrl);

    pageList[currentPageIndex] = {
      ...item,
      originalPageIndex: null,
      rotation: 0,
      crop: null,
      customImageDataUrl: dataUrl,
      customImageBlob: blob,
    };

    await commitPageHistoryEvent(pageId, {
      type: 'rotate_apply',
      ts: Date.now(),
      snapshot: {
        originalPageIndex: null,
        rotation: 0,
        crop: null,
        customImageBlob: blob,
      },
    });

    await renderSidebarThumbnails();
    await renderCurrentPage();
    await persistSessionNow();
    showToast('회전이 현재 페이지에 적용되었습니다.', 'success');
  } catch (err) {
    console.error(err);
    showToast('회전 적용에 실패했습니다.', 'error');
  } finally {
    hideLoading();
  }
}

async function generateCroppedImageDataUrl() {
  const item = pageList[currentPageIndex];
  // crop 결과 품질을 위해, 화면용 pdfCanvas 대신 저장용 렌더 스케일로 다시 렌더링합니다.
  const srcCanvas = await renderPageToCanvas(item, PAGE_IMAGE_STORAGE_RENDER_SCALE);
  try {
    const srcW = srcCanvas.width;
    const srcH = srcCanvas.height;

    const cropX = cropBox.x * srcW;
    const cropY = cropBox.y * srcH;
    const cropW = cropBox.w * srcW;
    const cropH = cropBox.h * srcH;

    const offCanvas = document.createElement('canvas');
    offCanvas.width = cropW;
    offCanvas.height = cropH;

    const ctx = offCanvas.getContext('2d');
    ctx.drawImage(
      srcCanvas,
      cropX, cropY, cropW, cropH,
      0, 0, cropW, cropH
    );

    return canvasToStorageDataUrl(offCanvas);
  } finally {
    try {
      srcCanvas.width = 0;
      srcCanvas.height = 0;
    } catch (_e) {}
  }
}

btnDeleteCurrentPage.addEventListener('click', () => {
  deletePage(currentPageIndex);
});

function deletePage(index) {
  if (pageList.length <= 1) {
    showToast('At least one page must remain.', 'warning');
    return;
  }

  const removedPageId = pageList[index]?.id;
  pageList.splice(index, 1);
  if (currentPageIndex >= pageList.length) {
    currentPageIndex = pageList.length - 1;
  }

  renderSidebarThumbnails();
  renderCurrentPage();
  notifyPageIndexChanged();
  showToast('Page deleted.', 'info');

  if (removedPageId) {
    pageHistoryEventsMap.delete(removedPageId);
    pageHistoryPointerMap.delete(removedPageId);
    pageHistoryBaselineMap.delete(removedPageId);
    void deletePageHistory(removedPageId).catch(() => {});
  }
}

function movePage(fromIndex, toIndex) {
  if (toIndex < 0 || toIndex >= pageList.length) return;
  const item = pageList.splice(fromIndex, 1)[0];
  pageList.splice(toIndex, 0, item);
  currentPageIndex = toIndex;
  renderSidebarThumbnails();
  renderCurrentPage();
  notifyPageIndexChanged();
}

function goToPrevPage() {
  clearPageInputDebounce();
  if (currentPageIndex > 0) {
    currentPageIndex--;
    renderCurrentPage();
    notifyPageIndexChanged();
  }
}

function goToNextPage() {
  clearPageInputDebounce();
  if (currentPageIndex < pageList.length - 1) {
    currentPageIndex++;
    renderCurrentPage();
    notifyPageIndexChanged();
  }
}

function isKeyboardInputTarget(target) {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

function goToPageByNumber(pageNum) {
  if (pageList.length === 0) return;

  const targetIndex = Math.max(1, Math.min(pageList.length, pageNum)) - 1;
  if (targetIndex === currentPageIndex) {
    currentPageNum.value = currentPageIndex + 1;
    return;
  }

  currentPageIndex = targetIndex;
  renderCurrentPage();
  notifyPageIndexChanged();
}

function clearPageInputDebounce() {
  if (pageInputDebounceTimer) {
    clearTimeout(pageInputDebounceTimer);
    pageInputDebounceTimer = null;
  }
}

function schedulePageInputNavigation() {
  if (pageInputDebounceTimer) clearTimeout(pageInputDebounceTimer);

  pageInputDebounceTimer = setTimeout(() => {
    pageInputDebounceTimer = null;

    if (pageList.length === 0) return;

    const raw = currentPageNum.value.trim();
    if (raw === '') {
      currentPageNum.value = currentPageIndex + 1;
      return;
    }

    const pageNum = parseInt(raw, 10);
    if (Number.isNaN(pageNum)) {
      currentPageNum.value = currentPageIndex + 1;
      return;
    }

    goToPageByNumber(pageNum);
  }, 500);
}

btnPrevPage.addEventListener('click', () => {
  goToPrevPage();
});

btnNextPage.addEventListener('click', () => {
  goToNextPage();
});

if (btnUndoPage) {
  btnUndoPage.addEventListener('click', () => {
    void undoOnCurrentPage();
  });
}

if (btnRedoPage) {
  btnRedoPage.addEventListener('click', () => {
    void redoOnCurrentPage();
  });
}

if (btnShowShortcuts) {
  btnShowShortcuts.addEventListener('click', () => {
    if (isShortcutsModalOpen) closeShortcutsModal();
    else openShortcutsModal();
  });
}

if (btnCloseProject) {
  btnCloseProject.addEventListener('click', () => {
    closeShortcutsModal();
    closeConfirmCropExitModal();
    closeConfirmDeleteProjectModal();
    resetEditorToNoProject();
  });
}

if (btnDeleteProject) {
  btnDeleteProject.addEventListener('click', async () => {
    closeShortcutsModal();
    closeConfirmCropExitModal();
    closeConfirmDeleteProjectModal();
    const confirmed = await openConfirmDeleteProjectModal();
    if (!confirmed) return;
    await deleteIndexedDbProjectAndReset();
  });
}

if (btnRestoreRecentSession) {
  btnRestoreRecentSession.addEventListener('click', async () => {
    // restoreEditorSession 내부에서 로딩/토스트를 처리합니다.
    await restoreEditorSession();
  });
}

if (btnClearRecentSession) {
  btnClearRecentSession.addEventListener('click', async () => {
    closeShortcutsModal();
    closeConfirmCropExitModal();
    closeConfirmDeleteProjectModal();
    const confirmed = await openConfirmDeleteProjectModal();
    if (!confirmed) return;

    showLoading('최근 작업 삭제 중...', 'IndexedDB를 초기화하고 있습니다.');
    try {
      await clearEditorSession();
      showToast('최근 작업 상태가 삭제되었습니다.', 'info');
      if (btnRestoreRecentSession) btnRestoreRecentSession.disabled = true;
      if (btnClearRecentSession) btnClearRecentSession.disabled = true;
      resetEditorToNoProject();
    } catch (err) {
      console.error('Clear Recent Session Error:', err);
      showToast('최근 작업 삭제에 실패했습니다.', 'error');
    } finally {
      hideLoading();
    }
  });
}

currentPageNum.addEventListener('input', schedulePageInputNavigation);

document.addEventListener('keydown', (e) => {
  // Modal shortcut handling (Esc/Enter) - 입력창 포커스 여부와 무관하게 동작
  if (isConfirmAlsoSaveProjectModalOpen) {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (confirmAlsoSaveProjectResolve) confirmAlsoSaveProjectResolve(false);
      closeConfirmAlsoSaveProjectModal();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (confirmAlsoSaveProjectResolve) confirmAlsoSaveProjectResolve(true);
      closeConfirmAlsoSaveProjectModal();
      return;
    }
    return;
  }

  if (isConfirmAfterProjectExportModalOpen) {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (confirmAfterProjectExportResolve) confirmAfterProjectExportResolve(false);
      closeConfirmAfterProjectExportModal();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (confirmAfterProjectExportResolve) confirmAfterProjectExportResolve(true);
      closeConfirmAfterProjectExportModal();
      return;
    }
    return;
  }

  if (isConfirmDeleteProjectModalOpen) {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (confirmDeleteProjectResolve) confirmDeleteProjectResolve(false);
      closeConfirmDeleteProjectModal();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (confirmDeleteProjectResolve) confirmDeleteProjectResolve(true);
      closeConfirmDeleteProjectModal();
      return;
    }
    return;
  }

  if (isConfirmCropExitModalOpen) {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (confirmCropExitResolve) confirmCropExitResolve(false);
      closeConfirmCropExitModal();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (confirmCropExitResolve) confirmCropExitResolve(true);
      closeConfirmCropExitModal();
      return;
    }
    return;
  }

  if (isShortcutsModalOpen) {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeShortcutsModal();
    }
    return;
  }

  if (isKeyboardInputTarget(e.target)) return;

  // crop 모드 토글(c)
  if (e.key === 'c' || e.key === 'C') {
    if (pageList.length === 0 || currentPageIndex < 0) return;
    e.preventDefault();
    if (!isCropMode) {
      enterCropMode();
    } else {
      void attemptExitCropModeWithConfirm();
    }
    return;
  }

  if (pageList.length === 0 || currentPageIndex < 0) return;
  if (!loadingOverlay.classList.contains('hidden')) return;

  if (handleCropShortcut(e)) {
    return;
  }

  if (handleRotationShortcut(e)) {
    return;
  }

  if (e.key === 'ArrowLeft') {
    e.preventDefault();
    goToPrevPage();
  } else if (e.key === 'ArrowRight') {
    e.preventDefault();
    goToNextPage();
  }
});

btnCopyClipboard.addEventListener('click', async () => {
  showLoading('Copying to clipboard...', 'Generating current page image.');
  try {
    const renderedCanvas = await renderFullPageToCanvas(pageList[currentPageIndex]);

    renderedCanvas.toBlob(async (blob) => {
      if (!blob) {
        showToast('Image generation failed', 'error');
        hideLoading();
        return;
      }

      try {
        const item = new ClipboardItem({ 'image/png': blob });
        await navigator.clipboard.write([item]);
        showToast('Image copied to clipboard!', 'success');
      } catch (err) {
        console.error('Clipboard API Error:', err);
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `page_${currentPageIndex + 1}.png`;
        a.click();
        showToast('Downloaded image (clipboard permission denied).', 'info');
      } finally {
        hideLoading();
      }
    }, 'image/png');
  } catch (err) {
    console.error(err);
    showToast('Clipboard copy failed.', 'error');
    hideLoading();
  }
});

async function renderPageToCanvas(item, scale = 2.0, reuseCanvas = null) {
  const deg = normalizeRotation(item.rotation);
  const rad = (deg * Math.PI) / 180;

  // 재사용 캔버스 모드(내보내기에서 단일 캔버스 재사용용)
  if (reuseCanvas) {
    const ctx = reuseCanvas.getContext('2d');
    if (!ctx) throw new Error('Failed to get 2D context from reuseCanvas.');

    let srcW = 0;
    let srcH = 0;

    if (item.customImageDataUrl) {
      const img = await loadImage(item.customImageDataUrl);
      reuseCanvas.width = img.width;
      reuseCanvas.height = img.height;
      ctx.clearRect(0, 0, img.width, img.height);
      ctx.drawImage(img, 0, 0);
      srcW = img.width;
      srcH = img.height;
    } else {
      const page = await getPdfPageCached(item.originalPageIndex);
      const viewport = page.getViewport({ scale });
      reuseCanvas.width = viewport.width;
      reuseCanvas.height = viewport.height;
      ctx.clearRect(0, 0, viewport.width, viewport.height);

      const renderTaskCtx = reuseCanvas.getContext('2d');
      let renderTask = null;
      try {
        renderTask = page.render({ canvasContext: renderTaskCtx, viewport });
        await renderTask.promise;
      } catch (err) {
        if (renderTask && typeof renderTask.cancel === 'function') {
          try {
            renderTask.cancel();
          } catch (_e) {}
        }
        throw err;
      } finally {
        renderTask = null;
      }

      srcW = viewport.width;
      srcH = viewport.height;
    }

    if (deg === 0) return reuseCanvas;

    // 회전 시, 캔버스 리사이즈 전에 현재 내용을 비트맵으로 보존
    const sin = Math.abs(Math.sin(rad));
    const cos = Math.abs(Math.cos(rad));

    let bitmap = null;
    try {
      bitmap = await createImageBitmap(reuseCanvas);
    } catch (_e) {
      // createImageBitmap 미지원/실패 시 fallback
      const img = new Image();
      img.src = reuseCanvas.toDataURL('image/png');
      await img.decode();
      bitmap = img;
    }

    const newW = Math.round(srcW * cos + srcH * sin);
    const newH = Math.round(srcW * sin + srcH * cos);

    reuseCanvas.width = newW;
    reuseCanvas.height = newH;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, newW, newH);

    ctx.translate(newW / 2, newH / 2);
    ctx.rotate(rad);
    ctx.drawImage(bitmap, -srcW / 2, -srcH / 2);

    // 리사이즈/그림 이후 변환 상태 초기화
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    if (bitmap && typeof bitmap.close === 'function') {
      try {
        bitmap.close();
      } catch (_e) {}
    }

    return reuseCanvas;
  }

  // 기존(호환) 모드
  const offCanvas = document.createElement('canvas');
  const ctx = offCanvas.getContext('2d');
  let srcCanvas;

  if (item.customImageDataUrl) {
    const img = await loadImage(item.customImageDataUrl);
    srcCanvas = document.createElement('canvas');
    srcCanvas.width = img.width;
    srcCanvas.height = img.height;
    const sCtx = srcCanvas.getContext('2d');
    sCtx.drawImage(img, 0, 0);
  } else {
    const page = await getPdfPageCached(item.originalPageIndex);
    const viewport = page.getViewport({ scale });
    srcCanvas = document.createElement('canvas');
    srcCanvas.width = viewport.width;
    srcCanvas.height = viewport.height;
    const sCtx = srcCanvas.getContext('2d');
    let renderTask = null;
    try {
      renderTask = page.render({ canvasContext: sCtx, viewport });
      await renderTask.promise;
    } catch (err) {
      if (renderTask && typeof renderTask.cancel === 'function') {
        try {
          renderTask.cancel();
        } catch (_e) {}
      }
      throw err;
    } finally {
      renderTask = null;
    }
  }

  if (deg === 0) {
    return srcCanvas;
  }

  const sin = Math.abs(Math.sin(rad));
  const cos = Math.abs(Math.cos(rad));

  const srcW = srcCanvas.width;
  const srcH = srcCanvas.height;

  offCanvas.width = Math.round(srcW * cos + srcH * sin);
  offCanvas.height = Math.round(srcW * sin + srcH * cos);

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, offCanvas.width, offCanvas.height);

  ctx.translate(offCanvas.width / 2, offCanvas.height / 2);
  ctx.rotate(rad);
  ctx.drawImage(srcCanvas, -srcW / 2, -srcH / 2);

  return offCanvas;
}

function cancelActivePageRender() {
  if (!currentRenderTask) return;
  try {
    currentRenderTask.cancel();
  } catch (_e) {}
  currentRenderTask = null;
}

async function renderExportPageToCanvas(item, scale, targetCanvas, scratchCanvas, scratchCtx, maxSourceDimension) {
  const deg = normalizeRotation(item.rotation);
  const rad = (deg * Math.PI) / 180;
  const ctx = targetCanvas.getContext('2d');
  if (!ctx) throw new Error('Failed to get 2D context from export canvas.');

  let srcW = 0;
  let srcH = 0;
  let pdfPage = null;

  try {
    if (item.customImageDataUrl) {
      const img = await loadImage(item.customImageDataUrl);
      const { w, h } = getScaledSize(img.width, img.height, maxSourceDimension);
      targetCanvas.width = w;
      targetCanvas.height = h;
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      srcW = w;
      srcH = h;
    } else {
      pdfPage = await pdfDoc.getPage(item.originalPageIndex);
      const baseViewport = pdfPage.getViewport({ scale: 1 });
      const fitScale = Math.min(
        scale,
        maxSourceDimension / baseViewport.width,
        maxSourceDimension / baseViewport.height
      );
      const viewport = pdfPage.getViewport({ scale: Math.max(fitScale, 0.1) });

      targetCanvas.width = viewport.width;
      targetCanvas.height = viewport.height;
      ctx.clearRect(0, 0, viewport.width, viewport.height);

      let renderTask = null;
      try {
        renderTask = pdfPage.render({ canvasContext: ctx, viewport });
        await renderTask.promise;
      } catch (err) {
        if (renderTask && typeof renderTask.cancel === 'function') {
          try {
            renderTask.cancel();
          } catch (_e) {}
        }
        throw err;
      }

      srcW = viewport.width;
      srcH = viewport.height;
    }

    if (deg === 0) return targetCanvas;

    scratchCanvas.width = srcW;
    scratchCanvas.height = srcH;
    scratchCtx.clearRect(0, 0, srcW, srcH);
    scratchCtx.drawImage(targetCanvas, 0, 0);

    const sin = Math.abs(Math.sin(rad));
    const cos = Math.abs(Math.cos(rad));
    const newW = Math.round(srcW * cos + srcH * sin);
    const newH = Math.round(srcW * sin + srcH * cos);

    targetCanvas.width = newW;
    targetCanvas.height = newH;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, newW, newH);
    ctx.translate(newW / 2, newH / 2);
    ctx.rotate(rad);
    ctx.drawImage(scratchCanvas, -srcW / 2, -srcH / 2);
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    scratchCanvas.width = 0;
    scratchCanvas.height = 0;

    return targetCanvas;
  } finally {
    if (pdfPage && typeof pdfPage.cleanup === 'function') {
      try {
        pdfPage.cleanup();
      } catch (_e) {}
    }
    pageCache.delete(item.originalPageIndex);
  }
}

async function renderFullPageToCanvas(item) {
  return renderPageToCanvas(item, 2.0);
}

// Export용: 출력 PDF 크기를 줄이기 위한 다운스케일/압축 설정
const EXPORT_RENDER_SCALE = 1.75;
const EXPORT_JPEG_QUALITY = 0.95;
// Export 시 메모리/성능 절충용 다운스케일 상한
// - 값이 너무 낮으면 저장된 고해상도 이미지가 다시 줄어들어 품질이 손상됩니다.
const EXPORT_MAX_CANVAS_DIMENSION = 3000;

function getExportMaxCanvasDimension() {
  // crop/편집 저장 해상도보다 export 상한이 낮으면 품질이 저장 시점에 고정됩니다.
  return Math.max(EXPORT_MAX_CANVAS_DIMENSION, PAGE_IMAGE_STORAGE_MAX_WIDTH);
}

function getScaledSize(width, height, maxDimension) {
  if (width <= maxDimension && height <= maxDimension) {
    return { w: width, h: height };
  }

  const scale = Math.min(maxDimension / width, maxDimension / height);
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  return { w, h };
}

function resizeAndDrawToReusableCanvas(sourceCanvas, targetCanvas, targetCtx, maxDimension) {
  const { w, h } = getScaledSize(sourceCanvas.width, sourceCanvas.height, maxDimension);

  targetCanvas.width = w;
  targetCanvas.height = h;

  targetCtx.clearRect(0, 0, w, h);
  targetCtx.drawImage(sourceCanvas, 0, 0, w, h);
}

function canvasToJpegBlob(canvas, quality, mime = 'image/jpeg') {
  return new Promise((resolve, reject) => {
    if (!canvas || canvas.width <= 0 || canvas.height <= 0) {
      reject(new Error(`Invalid canvas for JPEG encode: ${canvas?.width}x${canvas?.height}`));
      return;
    }

    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error(`Failed to create JPEG blob (${canvas.width}x${canvas.height}).`));
          return;
        }
        resolve(blob);
      },
      mime,
      quality
    );
  });
}

async function canvasToJpegBlobFromCanvas(sourceCanvas, quality, encodeCanvas, encodeCtx) {
  try {
    return await canvasToJpegBlob(sourceCanvas, quality, 'image/jpeg');
  } catch (directErr) {
    console.warn('[Export]', 'direct toBlob failed', directErr);
  }

  encodeCanvas.width = sourceCanvas.width;
  encodeCanvas.height = sourceCanvas.height;
  encodeCtx.clearRect(0, 0, encodeCanvas.width, encodeCanvas.height);
  encodeCtx.drawImage(sourceCanvas, 0, 0);

  try {
    const blob = await canvasToJpegBlob(encodeCanvas, quality, 'image/jpeg');
    return blob;
  } catch (copyErr) {
    console.warn('[Export]', 'encode canvas toBlob failed', copyErr);
  } finally {
    try {
      encodeCanvas.width = 0;
      encodeCanvas.height = 0;
    } catch (_e) {}
  }

  let dataUrl = '';
  try {
    dataUrl = sourceCanvas.toDataURL('image/jpeg', quality);
  } catch (dataUrlErr) {
    throw dataUrlErr;
  }

  if (!dataUrl.startsWith('data:image/')) {
    throw new Error('toDataURL produced invalid JPEG data.');
  }

  const response = await fetch(dataUrl);
  const blob = await response.blob();
  if (!blob || blob.size === 0) {
    throw new Error('Failed to convert JPEG data URL to blob.');
  }
  return blob;
}

async function downscaleCanvasInPlace(canvas, maxDimension) {
  if (!canvas) return;
  if (canvas.width <= maxDimension && canvas.height <= maxDimension) return;

  const srcW = canvas.width;
  const srcH = canvas.height;
  const { w, h } = getScaledSize(srcW, srcH, maxDimension);

  let bitmap = null;
  try {
    bitmap = await createImageBitmap(canvas);
  } catch (_e) {
    // fallback: dataURL -> Image
    const img = new Image();
    img.src = canvas.toDataURL('image/png');
    await img.decode();
    bitmap = img;
  }

  canvas.width = w;
  canvas.height = h;

  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(bitmap, 0, 0, w, h);

  if (bitmap && typeof bitmap.close === 'function') {
    try {
      bitmap.close();
    } catch (_e) {}
  }
}

// Export 전용: ImageBitmap/toDataURL 없이 scratch canvas로 다운스케일(메모리 피크 방지)
function downscaleCanvasForExport(sourceCanvas, maxDimension, scratchCanvas, scratchCtx) {
  if (!sourceCanvas) return;
  if (sourceCanvas.width <= maxDimension && sourceCanvas.height <= maxDimension) return;

  const { w, h } = getScaledSize(sourceCanvas.width, sourceCanvas.height, maxDimension);
  scratchCanvas.width = w;
  scratchCanvas.height = h;
  scratchCtx.clearRect(0, 0, w, h);
  scratchCtx.drawImage(sourceCanvas, 0, 0, w, h);

  sourceCanvas.width = w;
  sourceCanvas.height = h;
  const ctx = sourceCanvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(scratchCanvas, 0, 0);

  scratchCanvas.width = 0;
  scratchCanvas.height = 0;
}

async function compactExportPdfDoc(doc, label) {
  logExportMemory(`checkpoint start ${label}`);
  const checkpointBytes = await doc.save({ useObjectStreams: true });
  if (typeof doc.cleanup === 'function') {
    try {
      await doc.cleanup();
    } catch (_e) {}
  }
  const reloadedDoc = await PDFDocument.load(checkpointBytes);
  await new Promise((r) => setTimeout(r, 200));
  pageCache.clear();
  thumbnailCache.clear();
  logExportMemory(`checkpoint done ${label}`);
  console.debug('[Export]', `checkpoint done ${label}`, `bytes=${checkpointBytes.length}`);
  return reloadedDoc;
}

function logExportMemory(label) {
  const perf = performance;
  if (!perf || !('memory' in perf) || !perf.memory) return;

  const memory = perf.memory;
  console.debug('[Export]', label, {
    usedMB: Math.round(memory.usedJSHeapSize / 1048576),
    totalMB: Math.round(memory.totalJSHeapSize / 1048576),
    limitMB: Math.round(memory.jsHeapSizeLimit / 1048576),
  });
}

async function encodeExportPageImage(canvas, quality, scratchCanvas, scratchCtx, encodeCanvas, encodeCtx) {
  const attempts = [
    { quality, maxDimension: null },
    { quality: Math.max(0.8, quality - 0.06), maxDimension: null },
    { quality: Math.max(0.72, quality - 0.12), maxDimension: 1600 },
    { quality: 0.65, maxDimension: 1280 },
  ];

  let lastError = null;
  for (const attempt of attempts) {
    try {
      if (attempt.maxDimension) {
        downscaleCanvasForExport(canvas, attempt.maxDimension, scratchCanvas, scratchCtx);
      }

      console.debug('[Export]', 'encode attempt', {
        quality: attempt.quality,
        maxDimension: attempt.maxDimension,
        size: `${canvas.width}x${canvas.height}`,
      });
      logExportMemory('before blob');

      await new Promise((r) => setTimeout(r, 0));

      const blob = await canvasToJpegBlobFromCanvas(
        canvas,
        attempt.quality,
        encodeCanvas,
        encodeCtx
      );
      console.debug('[Export]', 'blob created', `size=${blob.size}`);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      console.debug('[Export]', 'bytes created', `len=${bytes.length}`);
      logExportMemory('after bytes');
      return bytes;
    } catch (err) {
      lastError = err;
      console.warn('[Export]', 'encode attempt failed', attempt, err);
    }
  }

  throw lastError || new Error('Failed to encode export page image.');
}

const EXPORT_SEG_DB_NAME = 'pdf-page-editor-export';
const EXPORT_SEG_STORE = 'segments';

function openExportSegDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(EXPORT_SEG_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(EXPORT_SEG_STORE)) {
        db.createObjectStore(EXPORT_SEG_STORE, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function makeExportSegId(sessionId, index) {
  return `${sessionId}:${index}`;
}

async function saveExportSegmentBytes(sessionId, index, bytes) {
  const db = await openExportSegDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(EXPORT_SEG_STORE, 'readwrite');
    tx.objectStore(EXPORT_SEG_STORE).put({
      id: makeExportSegId(sessionId, index),
      bytes,
    });
    tx.oncomplete = () => {
      db.close();
      resolve(undefined);
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

async function loadExportSegmentBytes(sessionId, index) {
  const db = await openExportSegDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(EXPORT_SEG_STORE, 'readonly');
    const req = tx.objectStore(EXPORT_SEG_STORE).get(makeExportSegId(sessionId, index));
    req.onsuccess = () => {
      db.close();
      resolve(req.result?.bytes || null);
    };
    req.onerror = () => {
      db.close();
      reject(req.error);
    };
  });
}

async function deleteExportSegmentBytes(sessionId, index) {
  const db = await openExportSegDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(EXPORT_SEG_STORE, 'readwrite');
    tx.objectStore(EXPORT_SEG_STORE).delete(makeExportSegId(sessionId, index));
    tx.oncomplete = () => {
      db.close();
      resolve(undefined);
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

async function clearExportSegments(sessionId, segmentCount) {
  for (let i = 0; i < segmentCount; i++) {
    try {
      await deleteExportSegmentBytes(sessionId, i);
    } catch (_e) {}
  }
}

async function clearAllExportSegmentStore() {
  const db = await openExportSegDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(EXPORT_SEG_STORE, 'readwrite');
    tx.objectStore(EXPORT_SEG_STORE).clear();
    tx.oncomplete = () => {
      db.close();
      resolve(undefined);
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

async function prepareIndexedDbForExport() {
  console.debug('[Export]', 'preparing IndexedDB space...');
  await clearAllExportSegmentStore();
  await clearEditorSession();
  console.debug('[Export]', 'IndexedDB space prepared');
}

async function saveExportSegmentBytesWithRetry(sessionId, index, bytes) {
  try {
    await saveExportSegmentBytes(sessionId, index, bytes);
  } catch (err) {
    if (err?.name !== 'QuotaExceededError') throw err;

    console.warn('[Export]', `QuotaExceeded on segment ${index + 1}, clearing IndexedDB and retrying`);
    await prepareIndexedDbForExport();
    await saveExportSegmentBytes(sessionId, index, bytes);
  }
}

async function mergeExportSegments(sessionId, segmentCount, pageCount) {
  let finalDoc = null;

  for (let segIdx = 0; segIdx < segmentCount; segIdx++) {
    updateExportToast(`PDF 병합 중 (세그먼트 ${segIdx + 1}/${segmentCount})...`);
    const segBytes = await loadExportSegmentBytes(sessionId, segIdx);
    if (!segBytes) {
      throw new Error(`Export segment missing: ${segIdx}`);
    }

    console.debug('[Export]', `merge segment ${segIdx + 1}/${segmentCount}`, `bytes=${segBytes.length}`);
    logExportMemory(`merge segment ${segIdx + 1}`);

    if (!finalDoc) {
      finalDoc = await PDFDocument.load(segBytes);
    } else {
      const segDoc = await PDFDocument.load(segBytes);
      const indices = segDoc.getPageIndices();
      const copiedPages = await finalDoc.copyPages(segDoc, indices);
      copiedPages.forEach((p) => finalDoc.addPage(p));
      if (typeof segDoc.cleanup === 'function') {
        try {
          await segDoc.cleanup();
        } catch (_e) {}
      }
    }

    await deleteExportSegmentBytes(sessionId, segIdx);

    const mergeCheckpointEvery = pageCount >= 500 ? 2 : 4;
    if (
      finalDoc &&
      (segIdx + 1) % mergeCheckpointEvery === 0 &&
      segIdx + 1 < segmentCount
    ) {
      finalDoc = await compactExportPdfDoc(finalDoc, `merge-${segIdx + 1}/${segmentCount}`);
    }

    pageCache.clear();
    thumbnailCache.clear();
    await new Promise((r) => setTimeout(r, 150));
  }

  if (!finalDoc) {
    throw new Error('Failed to merge export segments.');
  }

  return finalDoc;
}

async function appendExportPageToDoc({
  doc,
  item,
  pageIndex,
  pageCount,
  workCanvas,
  scratchCanvas,
  scratchCtx,
  encodeCanvas,
  encodeCtx,
  exportRenderScale,
  exportMaxCanvasDimension,
  exportJpegQuality,
  useWebp,
}) {
  cancelActivePageRender();
  pageCache.clear();
  thumbnailCache.clear();
  await new Promise((r) => setTimeout(r, 0));

  console.debug('[Export]', `render start (${pageIndex + 1}/${pageCount})`);
  await renderExportPageToCanvas(
    item,
    exportRenderScale,
    workCanvas,
    scratchCanvas,
    scratchCtx,
    exportMaxCanvasDimension
  );
  console.debug('[Export]', `render done (${pageIndex + 1}/${pageCount})`, `${workCanvas.width}x${workCanvas.height}`);

  // renderExportPageToCanvas가 max dimension을 맞추지만, 회전 등으로 상한을 넘을 수 있어 1회만 보정합니다.
  downscaleCanvasForExport(workCanvas, exportMaxCanvasDimension, scratchCanvas, scratchCtx);
  console.debug('[Export]', `downscale done (${pageIndex + 1}/${pageCount})`, `${workCanvas.width}x${workCanvas.height}`);

  pageCache.clear();
  if (pageCount >= 400) {
    thumbnailCache.clear();
  }

  const imageBytes = await encodeExportPageImage(
    workCanvas,
    exportJpegQuality,
    scratchCanvas,
    scratchCtx,
    encodeCanvas,
    encodeCtx
  );
  const imgObj = useWebp ? await doc.embedWebp(imageBytes) : await doc.embedJpg(imageBytes);
  console.debug('[Export]', `embed done (${pageIndex + 1}/${pageCount})`);

  const page = doc.addPage([imgObj.width, imgObj.height]);
  page.drawImage(imgObj, {
    x: 0,
    y: 0,
    width: imgObj.width,
    height: imgObj.height,
  });
  console.debug('[Export]', `page added (${pageIndex + 1}/${pageCount})`, `pages=${doc.getPageCount()}`);

  if ((pageIndex + 1) % 25 === 0) {
    await new Promise((r) => setTimeout(r, 100));
    logExportMemory(`page pause ${pageIndex + 1}`);
  }
}

async function renderFullPageToCanvasForExport(item) {
  return renderPageToCanvas(item, EXPORT_RENDER_SCALE);
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

btnExportPdf.addEventListener('click', async () => {
  if (pageList.length === 0) return;

  const alsoSaveProject = await openConfirmAlsoSaveProjectModal();
  if (alsoSaveProject && !pdfSourceData) {
    showToast('원본 PDF 데이터가 없어 프로젝트는 저장하지 않습니다.', 'warning');
  }

  const shouldSaveProject = alsoSaveProject && !!pdfSourceData;

  const exportSessionId = `export-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  let exportSegmentCount = 0;

  try {
    const suggestedName = originalFileName || 'edited_document.pdf';
    let fileHandle: FileSystemFileHandle | null = null;
    let projectFileHandle: FileSystemFileHandle | null = null;

    // File System Access API는 showSaveFilePicker 호출 시점에 사용자 제스처가 필요합니다.
    // 그래서 "PDF 바이트를 만드는 무거운 await" 전에 먼저 파일 핸들을 확보합니다.
    if (window.showSaveFilePicker) {
      showToast('저장을 위해 File System Access API를 사용합니다.', 'info');
      try {
        fileHandle = await window.showSaveFilePicker({
          suggestedName,
          types: [{ description: 'PDF', accept: { 'application/pdf': ['.pdf'] } }],
        });
      } catch (err: any) {
        // 사용자가 저장 창을 취소한 경우
        if (err?.name === 'AbortError') {
          hideExportToast();
          showToast('저장이 취소되었습니다.', 'info');
          return;
        }
        throw err;
      }

      if (shouldSaveProject) {
        try {
          projectFileHandle = await pickProjectExportFileHandle();
        } catch (err: any) {
          if (err?.name === 'AbortError') {
            showToast('프로젝트 저장 위치 선택이 취소되어 PDF만 저장합니다.', 'info');
          } else {
            throw err;
          }
        }
      }

      // 저장 위치 선택이 끝난 뒤에만 PDF 생성 UI를 보여줍니다.
      showExportToast('PDF 생성 중...');
    } else {
      // File System Access API가 없으면 바로 다운로드 플로우로 진행합니다.
      showExportToast('PDF 생성 중...');
    }

    const workCanvas = document.createElement('canvas');
    const workCtx = workCanvas.getContext('2d');
    if (!workCtx) throw new Error('Failed to create canvas context for export.');

    const scratchCanvas = document.createElement('canvas');
    const scratchCtx = scratchCanvas.getContext('2d');
    if (!scratchCtx) throw new Error('Failed to create scratch canvas context for export.');

    const encodeCanvas = document.createElement('canvas');
    const encodeCtx = encodeCanvas.getContext('2d');
    if (!encodeCtx) throw new Error('Failed to create encode canvas context for export.');

    const pageCount = pageList.length;
    const useSegmentedExport = pageCount >= 400;
    const exportRenderScale = EXPORT_RENDER_SCALE;
    const exportJpegQuality = EXPORT_JPEG_QUALITY;
    const exportMaxCanvasDimension = getExportMaxCanvasDimension();
    let exportCheckpointInterval = 0;
    let exportSegmentSize = 0;

    // 대용량 export도 품질 설정은 동일하게 유지하고, OOM 방지는 세그먼트 크기로만 조절합니다.
    if (pageCount >= 500) {
      exportSegmentSize = 5;
    } else if (pageCount >= 400) {
      exportSegmentSize = 8;
    }

    console.debug('[Export]', 'settings', {
      pageCount,
      useSegmentedExport,
      exportRenderScale,
      exportJpegQuality,
      exportMaxCanvasDimension,
      exportSegmentSize,
      exportCheckpointInterval,
      exportSessionId,
    });

    logExportMemory('export start');
    cancelActivePageRender();
    pageCache.clear();
    thumbnailCache.clear();

    let useWebp = false;
    let finalDoc = null;

    if (useSegmentedExport) {
      showToast('대용량 PDF 저장을 위해 IndexedDB 임시 데이터를 정리합니다.', 'info');
      await prepareIndexedDbForExport();

      let segmentDoc = null;
      let segmentIndex = 0;
      let pagesInSegment = 0;

      const flushExportSegment = async () => {
        if (!segmentDoc || pagesInSegment === 0) return;

        updateExportToast(`세그먼트 저장 중 (${segmentIndex + 1})...`);
        console.debug('[Export]', `segment flush start ${segmentIndex + 1}`, `pages=${pagesInSegment}`);
        logExportMemory(`segment flush start ${segmentIndex + 1}`);

        const segmentBytes = await segmentDoc.save({ useObjectStreams: true });
        if (typeof segmentDoc.cleanup === 'function') {
          try {
            await segmentDoc.cleanup();
          } catch (_e) {}
        }
        segmentDoc = null;

        await saveExportSegmentBytesWithRetry(exportSessionId, segmentIndex, segmentBytes);
        segmentIndex += 1;
        pagesInSegment = 0;
        exportSegmentCount = segmentIndex;

        console.debug('[Export]', `segment saved ${segmentIndex}`, `bytes=${segmentBytes.length}`);
        logExportMemory(`segment saved ${segmentIndex}`);
        pageCache.clear();
        thumbnailCache.clear();
        await new Promise((r) => setTimeout(r, 150));
      };

      for (let i = 0; i < pageCount; i++) {
        if (!segmentDoc) {
          segmentDoc = await PDFDocument.create();
        }

        updateExportToast(`PDF 생성 중 (${i + 1}/${pageCount})...`);

        const appendCurrentPage = async () => {
          await appendExportPageToDoc({
            doc: segmentDoc,
            item: pageList[i],
            pageIndex: i,
            pageCount,
            workCanvas,
            scratchCanvas,
            scratchCtx,
            encodeCanvas,
            encodeCtx,
            exportRenderScale,
            exportMaxCanvasDimension,
            exportJpegQuality,
            useWebp,
          });
        };

        try {
          try {
            await appendCurrentPage();
          } catch (err) {
            if (pagesInSegment > 0) {
              console.warn('[Export]', `retry after segment flush (${i + 1}/${pageCount})`, err);
              await flushExportSegment();
              segmentDoc = await PDFDocument.create();
              await appendCurrentPage();
            } else {
              throw err;
            }
          }

          pagesInSegment += 1;
          if (pagesInSegment >= exportSegmentSize) {
            await flushExportSegment();
          }
        } catch (err) {
          console.error('[Export]', `page failed (${i + 1}/${pageCount})`, err);
          throw err;
        } finally {
          try {
            workCanvas.width = 0;
            workCanvas.height = 0;
            scratchCanvas.width = 0;
            scratchCanvas.height = 0;
            encodeCanvas.width = 0;
            encodeCanvas.height = 0;
          } catch (_e) {}
        }
      }

      await flushExportSegment();
      updateExportToast('PDF 병합 중...');
      finalDoc = await mergeExportSegments(exportSessionId, segmentIndex, pageCount);
      exportSegmentCount = 0;
    } else {
      finalDoc = await PDFDocument.create();
      useWebp = typeof finalDoc.embedWebp === 'function';

      for (let i = 0; i < pageCount; i++) {
        updateExportToast(`PDF 생성 중 (${i + 1}/${pageCount})...`);

        try {
          await appendExportPageToDoc({
            doc: finalDoc,
            item: pageList[i],
            pageIndex: i,
            pageCount,
            workCanvas,
            scratchCanvas,
            scratchCtx,
            encodeCanvas,
            encodeCtx,
            exportRenderScale,
            exportMaxCanvasDimension,
            exportJpegQuality,
            useWebp,
          });

          if (
            exportCheckpointInterval > 0 &&
            (i + 1) % exportCheckpointInterval === 0 &&
            i + 1 < pageCount
          ) {
            updateExportToast(`메모리 정리 중 (${i + 1}/${pageCount})...`);
            finalDoc = await compactExportPdfDoc(finalDoc, `(${i + 1}/${pageCount})`);
          }

          if ((i + 1) % 5 === 0) {
            pageCache.clear();
            await new Promise((r) => setTimeout(r, 0));
          }
        } catch (err) {
          console.error('[Export]', `page failed (${i + 1}/${pageCount})`, err);
          throw err;
        } finally {
          try {
            workCanvas.width = 0;
            workCanvas.height = 0;
            scratchCanvas.width = 0;
            scratchCanvas.height = 0;
            encodeCanvas.width = 0;
            encodeCanvas.height = 0;
          } catch (_e) {}
        }
      }
    }

    updateExportToast('PDF 저장 준비 중...');
    console.debug('[Export]', 'final save start', `pages=${finalDoc.getPageCount()}`);
    logExportMemory('final save start');
    const pdfBytes = await finalDoc.save({ useObjectStreams: true });
    console.debug('[Export]', 'final save done', `bytes=${pdfBytes.length}`);
    logExportMemory('final save done');
    const outBlob = new Blob([pdfBytes], { type: 'application/pdf' });

    // File System Access API로 선택된 위치에 바로 저장
    if (fileHandle) {
      const writable = await fileHandle.createWritable();
      await writable.write(outBlob);
      await writable.close();
    } else {
      const url = URL.createObjectURL(outBlob);
      const link = document.createElement('a');
      link.href = url;
      link.download = suggestedName;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    }

    hideExportToast();
    showToast('PDF가 성공적으로 다운로드되었습니다.', 'success');

    if (shouldSaveProject) {
      try {
        showLoading('프로젝트 파일 생성 중...', '원본 PDF + 편집 상태를 묶고 있습니다.');
        await exportProjectFile({ fileHandle: projectFileHandle });
      } catch (projectErr) {
        console.error('Project Export Error (after PDF):', projectErr);
        showToast('PDF는 저장됐지만 프로젝트 저장에 실패했습니다.', 'error');
      } finally {
        hideLoading();
      }
    }
  } catch (err) {
    console.error('PDF Export Error:', err);
    hideExportToast();
    if (err?.name === 'QuotaExceededError') {
      showToast('브라우저 저장 공간이 부족합니다. IndexedDB를 정리했지만 공간이 부족할 수 있습니다.', 'error');
    } else {
      showToast('PDF 생성에 실패했습니다.', 'error');
    }
  } finally {
    try {
      await clearAllExportSegmentStore();
    } catch (_e) {}
  }
});

async function gzipBlobIfPossible(blob) {
  if (typeof CompressionStream === 'undefined') return { blob, used: false };
  try {
    const stream = blob.stream().pipeThrough(new CompressionStream('gzip'));
    const outBlob = await new Response(stream).blob();
    return { blob: outBlob, used: true };
  } catch (_e) {
    return { blob, used: false };
  }
}

function getProjectExportNameInfo() {
  const suggestedNameBase = (originalFileName || sourceFileName || 'pdf_project')
    .replace(/\.pdf$/i, '')
    .replace(/[^\w.\-]+/g, '_');
  const willTryGzip = typeof CompressionStream !== 'undefined';
  const outNameForPicker = willTryGzip
    ? `${suggestedNameBase}.pdfedit.gz`
    : `${suggestedNameBase}.pdfedit`;

  return { suggestedNameBase, outNameForPicker, willTryGzip };
}

async function createProjectExportBlob() {
  if (pageList.length === 0 || !pdfSourceData) {
    throw new Error('Project export data is unavailable.');
  }

  const project = {
    version: 1,
    createdAt: Date.now(),
    sourceFileName,
    originalFileName,
    currentPageIndex,
    pageList,
  };

  const jsonStr = JSON.stringify(project);
  const jsonBytes = new TextEncoder().encode(jsonStr);
  const magicBytes = new TextEncoder().encode('PDFPAGEEDIT\0');
  const header = new Uint8Array(magicBytes.length + 4);
  header.set(magicBytes, 0);
  new DataView(header.buffer).setUint32(magicBytes.length, jsonBytes.length, true);

  const rawBlob = new Blob([header, jsonBytes, pdfSourceData], { type: 'application/octet-stream' });
  return gzipBlobIfPossible(rawBlob);
}

async function pickProjectExportFileHandle() {
  if (!window.showSaveFilePicker) return null;

  const { outNameForPicker } = getProjectExportNameInfo();
  return window.showSaveFilePicker({
    suggestedName: outNameForPicker,
    types: [
      {
        description: 'PDF Edit Project',
        accept: { 'application/octet-stream': ['.pdfedit', '.pdfedit.gz'] },
      },
    ],
  });
}

async function writeProjectExportBlob(blobInfo, fileHandle = null) {
  const { blob, used } = blobInfo;
  const { suggestedNameBase, willTryGzip } = getProjectExportNameInfo();

  if (fileHandle) {
    const writable = await fileHandle.createWritable();
    await writable.write(blob);
    await writable.close();
    return;
  }

  const outName = used || willTryGzip
    ? `${suggestedNameBase}.pdfedit.gz`
    : `${suggestedNameBase}.pdfedit`;
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = outName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

async function exportProjectFile(options = {}) {
  const { fileHandle: presetFileHandle = null } = options;

  let fileHandle = presetFileHandle;
  if (window.showSaveFilePicker && !fileHandle) {
    showToast('저장을 위해 File System Access API를 사용합니다.', 'info');
    try {
      fileHandle = await pickProjectExportFileHandle();
    } catch (err) {
      if (err?.name === 'AbortError') {
        showToast('프로젝트 저장이 취소되었습니다.', 'info');
        return false;
      }
      throw err;
    }
  }

  const blobInfo = await createProjectExportBlob();
  await writeProjectExportBlob(blobInfo, fileHandle);
  showToast('프로젝트 파일이 성공적으로 다운로드되었습니다.', 'success');
  return true;
}

btnExportProject?.addEventListener('click', async () => {
  if (pageList.length === 0 || !pdfSourceData) return;

  showLoading('프로젝트 파일 생성 중...', '원본 PDF + 편집 상태를 묶고 있습니다.');
  try {
    const saved = await exportProjectFile();
    if (!saved) return;
  } catch (err) {
    console.error('Project Export Error:', err);
    showToast('프로젝트 파일 생성에 실패했습니다.', 'error');
    return;
  } finally {
    hideLoading();
  }

  closeShortcutsModal();
  closeConfirmCropExitModal();
  closeConfirmDeleteProjectModal();

  const shouldCleanupAndClose = await openConfirmAfterProjectExportModal();
  if (shouldCleanupAndClose) {
    showLoading('정리 중...', 'IndexedDB 캐시를 삭제하고 프로젝트를 닫습니다.');
    try {
      await clearEditorSession();
      resetEditorToNoProject();
      showToast('IndexedDB가 삭제되었고 프로젝트가 닫혔습니다.', 'info');
    } finally {
      hideLoading();
    }
  }
});

function showPageLoadingToast() {
  hidePageLoadingToast();

  const toastContainer = document.getElementById('toastContainer');
  if (!toastContainer) return;

  const toast = document.createElement('div');
  toast.className =
    'bg-slate-800 text-white px-4 py-3 rounded-xl shadow-lg flex items-center space-x-3 text-xs font-medium transform transition-all duration-300 translate-y-2 opacity-0 pointer-events-auto';
  toast.innerHTML =
    '<i class="fa-solid fa-circle-notch fa-spin text-blue-400 text-sm"></i>' +
    '<span>페이지 불러오는 중...</span>';

  toastContainer.appendChild(toast);
  pageRenderToastEl = toast;

  setTimeout(() => {
    toast.classList.remove('translate-y-2', 'opacity-0');
  }, 10);
}

function hidePageLoadingToast() {
  if (pageRenderToastTimer) {
    clearTimeout(pageRenderToastTimer);
    pageRenderToastTimer = null;
  }

  if (!pageRenderToastEl) return;

  const toast = pageRenderToastEl;
  pageRenderToastEl = null;
  toast.classList.add('opacity-0', 'translate-y-2');
  setTimeout(() => toast.remove(), 300);
}

function showExportToast(message) {
  hideExportToast();

  const toastContainer = document.getElementById('toastContainer');
  if (!toastContainer) return;

  const toast = document.createElement('div');
  toast.className =
    'bg-slate-800 text-white px-4 py-3 rounded-xl shadow-lg flex items-center space-x-3 text-xs font-medium transform transition-all duration-300 translate-y-2 opacity-0 pointer-events-auto';
  toast.innerHTML =
    '<i class="fa-solid fa-circle-notch fa-spin text-blue-400 text-sm"></i>' +
    `<span class="export-toast-message">${message}</span>`;

  toastContainer.appendChild(toast);
  exportToastEl = toast;

  setTimeout(() => {
    toast.classList.remove('translate-y-2', 'opacity-0');
  }, 10);
}

function updateExportToast(message) {
  console.debug('[Export]', message);
  if (!exportToastEl) return;
  const span = exportToastEl.querySelector('.export-toast-message');
  if (span) span.textContent = message;
}

function hideExportToast() {
  if (!exportToastEl) return;

  const toast = exportToastEl;
  exportToastEl = null;
  toast.classList.add('opacity-0', 'translate-y-2');
  setTimeout(() => toast.remove(), 300);
}

function showToast(message, type = 'info') {
  const toast = document.createElement('div');

  let bg = 'bg-slate-800 text-white';
  let icon = '<i class="fa-solid fa-circle-info text-blue-400"></i>';

  if (type === 'success') {
    bg = 'bg-emerald-800 text-white';
    icon = '<i class="fa-solid fa-circle-check text-emerald-300"></i>';
  } else if (type === 'error') {
    bg = 'bg-rose-800 text-white';
    icon = '<i class="fa-solid fa-triangle-exclamation text-rose-300"></i>';
  } else if (type === 'warning') {
    bg = 'bg-amber-800 text-white';
    icon = '<i class="fa-solid fa-circle-exclamation text-amber-300"></i>';
  }

  toast.className = `${bg} px-4 py-3 rounded-xl shadow-lg flex items-center space-x-3 text-xs font-medium transform transition-all duration-300 translate-y-2 opacity-0 pointer-events-auto`;
  toast.innerHTML = `${icon}<span>${message}</span>`;

  document.getElementById('toastContainer').appendChild(toast);

  setTimeout(() => {
    toast.classList.remove('translate-y-2', 'opacity-0');
  }, 10);

  setTimeout(() => {
    toast.classList.add('opacity-0', 'translate-y-2');
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

function showLoading(title, subtitle) {
  document.getElementById('loadingTitle').textContent = title;
  document.getElementById('loadingSubtitle').textContent = subtitle;
  loadingOverlay.classList.remove('hidden');
}

function updateLoadingSubtitle(subtitle) {
  document.getElementById('loadingSubtitle').textContent = subtitle;
}

function hideLoading() {
  loadingOverlay.classList.add('hidden');
}

function hasLoadedPdf() {
  return pageList.length > 0;
}

function handleBeforeUnload(event) {
  if (!hasLoadedPdf()) return;

  if (sessionSaveTimer) {
    clearTimeout(sessionSaveTimer);
    sessionSaveTimer = null;
  }
  void persistSessionNow();

  event.preventDefault();
  event.returnValue = '';
}

export async function initPdfPageEditor() {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'hidden') return;
    if (sessionSaveTimer) {
      clearTimeout(sessionSaveTimer);
      sessionSaveTimer = null;
    }
    void persistSessionNow();
  });

  window.addEventListener('pagehide', () => {
    if (sessionSaveTimer) {
      clearTimeout(sessionSaveTimer);
      sessionSaveTimer = null;
    }
    void persistSessionNow();
  });

  window.addEventListener('beforeunload', handleBeforeUnload);

  // Intro 화면 버튼 상태: 최근 작업이 있는 경우에만 복구/삭제 활성
  try {
    const session = await loadEditorSession();
    const hasSession = !!session;
    if (btnRestoreRecentSession) btnRestoreRecentSession.disabled = !hasSession;
    if (btnClearRecentSession) btnClearRecentSession.disabled = !hasSession;
  } catch (_e) {}

  await restoreEditorSession();
}
