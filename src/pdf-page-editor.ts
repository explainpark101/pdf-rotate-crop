// @ts-nocheck
import * as pdfjsLib from 'pdfjs-dist';
import { PDFDocument } from 'pdf-lib';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();

/* State Management */
let pdfDoc = null;
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

let isCropMode = false;
let cropBox = { x: 0.1, y: 0.1, w: 0.8, h: 0.8 };
let isDraggingCrop = false;
let isResizingCrop = false;
let activeHandle = null;
let dragStartX = 0, dragStartY = 0;
let cropStartBox = null;
let renderSeq = 0;
let pageRenderToastEl = null;
let pageRenderToastTimer = null;
let exportToastEl = null;

/* DOM Elements */
const pdfFileInput = document.getElementById('pdfFileInput');
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
const btnApplyCropToPage = document.getElementById('btnApplyCropToPage');
const btnAddCroppedPage = document.getElementById('btnAddCroppedPage');
const btnDeleteCurrentPage = document.getElementById('btnDeleteCurrentPage');
const btnPrevPage = document.getElementById('btnPrevPage');
const btnNextPage = document.getElementById('btnNextPage');
const btnExportPdf = document.getElementById('btnExportPdf');
const btnCopyClipboard = document.getElementById('btnCopyClipboard');
const loadingOverlay = document.getElementById('loadingOverlay');
const viewportContainer = document.getElementById('viewportContainer');

dropzone.addEventListener('click', () => pdfFileInput.click());

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
    if (file.type === 'application/pdf') {
      loadPdfFile(file);
    } else {
      showToast('PDF files only.', 'error');
    }
  }
});

pdfFileInput.addEventListener('change', (e) => {
  if (e.target.files && e.target.files[0]) {
    loadPdfFile(e.target.files[0]);
  }
});

async function loadPdfFile(file) {
  showLoading('PDF 파일을 읽는 중...', '문서 구조를 분석하고 있습니다.');
  try {
    originalFileName = file.name.replace('.pdf', '') + '_edited.pdf';
    docName.textContent = file.name;

    clearPdfCaches();

    const arrayBuffer = await file.arrayBuffer();
    const pdfData = new Uint8Array(arrayBuffer);

    pdfDoc = await pdfjsLib.getDocument({
      data: pdfData,
      disableAutoFetch: true,
      disableFontFace: true,
      verbosity: 0,
    }).promise;

    pageList = Array.from({ length: pdfDoc.numPages }, (_, i) => ({
      id: 'page_' + Date.now() + '_' + (i + 1),
      originalPageIndex: i + 1,
      rotation: 0,
      crop: null,
      customImageDataUrl: null,
    }));

    currentPageIndex = 0;
    dropzone.classList.add('hidden');
    canvasWrapper.classList.remove('hidden');
    editorToolbar.classList.remove('hidden');

    btnExportPdf.disabled = false;
    btnExportPdf.classList.remove('opacity-50', 'cursor-not-allowed');
    btnCopyClipboard.disabled = false;
    btnCopyClipboard.classList.remove('opacity-50', 'cursor-not-allowed');

    renderSidebarThumbnails();

    hideLoading();

    await getPdfPageCached(pageList[0].originalPageIndex);
    await renderCurrentPage();
    showToast('PDF 파일을 성공적으로 불러왔습니다.', 'success');
  } catch (error) {
    console.error('PDF Load Error:', error);
    showToast('PDF 파일을 읽는데 실패했습니다.', 'error');
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
  return Math.min(Math.max(fitScale, 0.75), 1.5);
}

function clearPdfCaches() {
  pageCache.clear();
  thumbnailCache.clear();
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
      btnCopyClipboard.disabled = true;
      btnCopyClipboard.classList.add('opacity-50', 'cursor-not-allowed');
      return;
    }
    currentPageIndex = 0;
  }

  const item = pageList[currentPageIndex];

  currentPageNum.textContent = currentPageIndex + 1;
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
    currentPageIndex = index;
    renderCurrentPage();
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
  isCropMode = !isCropMode;
  if (isCropMode) {
    btnToggleCrop.classList.replace('bg-slate-100', 'bg-slate-600');
    btnToggleCrop.classList.replace('hover:bg-blue-50', 'hover:bg-slate-500');
    btnToggleCrop.classList.replace('text-slate-700', 'text-white');
    cropBtnText.textContent = 'Cancel Crop';
    cropOverlay.classList.remove('hidden');
    btnApplyCropToPage.classList.remove('hidden');
    btnAddCroppedPage.classList.remove('hidden');
    cropBox = { x: 0.1, y: 0.1, w: 0.8, h: 0.8 };
    updateCropOverlayPosition();
  } else {
    btnToggleCrop.classList.replace('bg-slate-600', 'bg-slate-100');
    btnToggleCrop.classList.replace('hover:bg-slate-500', 'hover:bg-blue-50');
    btnToggleCrop.classList.replace('text-white', 'text-slate-700');
    cropBtnText.textContent = '영역 크롭 모드';
    cropOverlay.classList.add('hidden');
    btnApplyCropToPage.classList.add('hidden');
    btnAddCroppedPage.classList.add('hidden');
  }
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

btnAddCroppedPage.addEventListener('click', async () => {
  showLoading('크롭 영역 추출 중...', '선택한 영역을 새 페이지로 생성하고 있습니다.');
  try {
    const croppedDataUrl = await generateCroppedImageDataUrl();

    const newPageItem = {
      id: 'page_crop_' + Date.now(),
      originalPageIndex: null,
      rotation: 0,
      crop: null,
      customImageDataUrl: croppedDataUrl
    };

    pageList.splice(currentPageIndex + 1, 0, newPageItem);
    currentPageIndex++;

    btnToggleCrop.click();

    await renderSidebarThumbnails();
    await renderCurrentPage();
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
    const currentItem = pageList[currentPageIndex];

    pageList[currentPageIndex] = {
      ...currentItem,
      originalPageIndex: null,
      rotation: 0,
      crop: null,
      customImageDataUrl: croppedDataUrl
    };

    btnToggleCrop.click();

    await renderSidebarThumbnails();
    await renderCurrentPage();
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
  if (isRotationZero(item.rotation)) return;

  showLoading('회전 적용 중...', '현재 페이지에 회전을 반영하고 있습니다.');
  try {
    const canvas = await renderPageToCanvas(item, 2.0);
    const dataUrl = canvas.toDataURL('image/png');

    pageList[currentPageIndex] = {
      ...item,
      originalPageIndex: null,
      rotation: 0,
      crop: null,
      customImageDataUrl: dataUrl
    };

    await renderSidebarThumbnails();
    await renderCurrentPage();
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
  let srcCanvas = pdfCanvas;

  if (item.rotation !== 0) {
    srcCanvas = await renderPageToCanvas(item, 1.5);
  }

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

  return offCanvas.toDataURL('image/png');
}

btnDeleteCurrentPage.addEventListener('click', () => {
  deletePage(currentPageIndex);
});

function deletePage(index) {
  if (pageList.length <= 1) {
    showToast('At least one page must remain.', 'warning');
    return;
  }

  pageList.splice(index, 1);
  if (currentPageIndex >= pageList.length) {
    currentPageIndex = pageList.length - 1;
  }

  renderSidebarThumbnails();
  renderCurrentPage();
  showToast('Page deleted.', 'info');
}

function movePage(fromIndex, toIndex) {
  if (toIndex < 0 || toIndex >= pageList.length) return;
  const item = pageList.splice(fromIndex, 1)[0];
  pageList.splice(toIndex, 0, item);
  currentPageIndex = toIndex;
  renderSidebarThumbnails();
  renderCurrentPage();
}

function goToPrevPage() {
  if (currentPageIndex > 0) {
    currentPageIndex--;
    renderCurrentPage();
  }
}

function goToNextPage() {
  if (currentPageIndex < pageList.length - 1) {
    currentPageIndex++;
    renderCurrentPage();
  }
}

function isKeyboardInputTarget(target) {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

btnPrevPage.addEventListener('click', () => {
  goToPrevPage();
});

btnNextPage.addEventListener('click', () => {
  goToNextPage();
});

document.addEventListener('keydown', (e) => {
  if (isKeyboardInputTarget(e.target)) return;
  if (pageList.length === 0 || currentPageIndex < 0) return;
  if (!loadingOverlay.classList.contains('hidden')) return;

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

async function renderPageToCanvas(item, scale = 2.0) {
  const offCanvas = document.createElement('canvas');
  const ctx = offCanvas.getContext('2d');
  const deg = normalizeRotation(item.rotation);
  const rad = (deg * Math.PI) / 180;

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
    await page.render({ canvasContext: sCtx, viewport }).promise;
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

async function renderFullPageToCanvas(item) {
  return renderPageToCanvas(item, 2.0);
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

  showExportToast('PDF 생성 중...');
  try {
    const pdfDocOutput = await PDFDocument.create();

    for (let i = 0; i < pageList.length; i++) {
      const item = pageList[i];
      updateExportToast(`페이지 처리 중 (${i + 1}/${pageList.length})...`);

      const canvas = await renderFullPageToCanvas(item);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.92);

      const jpgImage = await pdfDocOutput.embedJpg(dataUrl);
      const page = pdfDocOutput.addPage([jpgImage.width, jpgImage.height]);

      page.drawImage(jpgImage, {
        x: 0,
        y: 0,
        width: jpgImage.width,
        height: jpgImage.height,
      });
    }

    updateExportToast('PDF 저장 중...');

    const pdfBytes = await pdfDocOutput.save();

    const blob = new Blob([pdfBytes], { type: 'application/pdf' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = originalFileName || 'edited_document.pdf';
    link.click();

    hideExportToast();
    showToast('PDF가 성공적으로 다운로드되었습니다.', 'success');
  } catch (err) {
    console.error('PDF Export Error:', err);
    hideExportToast();
    showToast('PDF 생성에 실패했습니다.', 'error');
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

export function initPdfPageEditor() {
  // All event listeners are registered above at module scope.
  // This function exists as the module entry point called from main.ts.
}
