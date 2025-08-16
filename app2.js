// ===== elements =====
const videoEl  = document.getElementById('preview');
const cameraSelect = document.getElementById('cameraSelect');
const startBtn = document.getElementById('startBtn');
const stopBtn  = document.getElementById('stopBtn');
const torchBtn = document.getElementById('torchBtn');
const statusEl = document.getElementById('status');
const resultEl = document.getElementById('result');
const openBtn  = document.getElementById('openBtn');
const copyBtn  = document.getElementById('copyBtn');
const fileInput= document.getElementById('fileInput');
const autoOpen = document.getElementById('autoOpen');

// Tabs + generator
const scanTab = document.getElementById('tab-scan');
const genTab  = document.getElementById('tab-generate');
const scanSection = document.getElementById('scan-section');
const genSection  = document.getElementById('generate-section');
const genBtn  = document.getElementById('genBtn');
const qrText  = document.getElementById('qrText');
const qrSize  = document.getElementById('qrSize');
const qrOutput= document.getElementById('qrOutput');

let currentDeviceId = null;
let currentStream   = null;
let loopTimer       = null;
let hitLocked       = false;
let torchOn         = false;

const secure = window.isSecureContext || ['localhost','127.0.0.1'].includes(location.hostname);
const isMobile  = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

// ===== helpers =====
const setStatus = (t) => { statusEl && (statusEl.textContent = t); };
function enableBtns(startEnabled){ if(startBtn&&stopBtn){ startBtn.disabled = !startEnabled; stopBtn.disabled = startEnabled; } }
function mirrorPreview(on){ if(videoEl) videoEl.style.transform = on ? 'scaleX(-1)' : 'none'; }

function highResConstraints(deviceId){
  const base = {
    width:  { ideal: 2560 },
    height: { ideal: 1440 },
    frameRate: { ideal: 30, max: 60 },
    advanced: [{ focusMode: 'continuous' }]
  };
  return deviceId ? { deviceId: { exact: deviceId }, ...base } : { facingMode: 'user', ...base };
}

// --- Normalize decoded text into something useful/tappable ---
function normalizePayload(text){
  if (!text) return {raw:'', display:'', href:'', scheme:''};
  let raw = (''+text).trim();
  try { raw = decodeURIComponent(raw); } catch {}

  if (/^(phon\.pe|phonepe\.com|[a-z0-9.-]+\.[a-z]{2,})(\/|$)/i.test(raw) && !/^https?:\/\//i.test(raw)){
    raw = 'https://' + raw;
  }

  if (/^https?:\/\//i.test(raw)) return { raw, display: raw, href: raw, scheme: 'http' };
  if (/^upi:/i.test(raw))         return { raw, display: raw, href: raw, scheme: 'upi' };
  if (/^intent:/i.test(raw))      return { raw, display: raw, href: raw, scheme: 'intent' };

  try {
    const maybe = raw.startsWith('http') ? raw : 'https://' + raw;
    new URL(maybe);
    return { raw, display: raw, href: maybe, scheme: 'http' };
  } catch {}

  return { raw, display: raw, href: '', scheme: 'text' };
}

// Create a quick QR data URL for “show on phone”
function makeQRDataURL(str){
  const canvas = document.createElement('canvas');
  canvas.width = 256; canvas.height = 256;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0,0,256,256);
  try {
    if (ZXing && ZXing.BrowserQRCodeSvgWriter) {
      const writer = new ZXing.BrowserQRCodeSvgWriter();
      const svg = writer.write(str, 256, 256);
      const img = new Image();
      const svgBlob = new Blob([svg.outerHTML], { type: 'image/svg+xml;charset=utf-8' });
      const url = URL.createObjectURL(svgBlob);
      return new Promise((resolve) => {
        img.onload = () => { ctx.drawImage(img, 0, 0); URL.revokeObjectURL(url); resolve(canvas.toDataURL()); };
        img.src = url;
      });
    }
  } catch {}
  return Promise.resolve(canvas.toDataURL());
}

function showHit(text){
  hitLocked = true;
  const norm = normalizePayload(text);
  if (resultEl) resultEl.textContent = norm.display || norm.raw || '—';
  if (openBtn)  openBtn.disabled  = !norm.href;
  if (copyBtn)  copyBtn.disabled  = !(norm.raw && norm.raw.length);
  setStatus('QR detected ✅');

  if (autoOpen?.checked) {
    if (norm.scheme === 'http') {
      window.open(norm.href, '_blank', 'noopener');
    } else if ((norm.scheme === 'upi' || norm.scheme === 'intent') && isMobile) {
      location.href = norm.href;
    }
  }

  if (!isMobile && (norm.scheme === 'upi' || norm.scheme === 'intent')) {
    makeQRDataURL(norm.raw).then(dataUrl => {
      if (statusEl) statusEl.innerHTML = 'UPI link decoded. Scan this with your phone to open:<br><img alt="UPI QR" style="margin-top:8px;width:160px;height:160px;border-radius:8px" src="'+dataUrl+'">';
    });
  }
}

// ===== decode helpers (ZXing + jsQR, multi-scale, full+ROI) =====
function cropCenter(canvas, scale){
  const w = Math.max(64, Math.floor(canvas.width * scale));
  const h = Math.max(64, Math.floor(canvas.height* scale));
  const x = Math.floor((canvas.width  - w)/2);
  const y = Math.floor((canvas.height - h)/2);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').drawImage(canvas, x, y, w, h, 0, 0, w, h);
  return c;
}

function tryZXing(canvas){
  try {
    const hints = new ZXing.Map();
    hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, [ZXing.BarcodeFormat.QR_CODE]);
    hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
    const core = new ZXing.MultiFormatReader(); core.setHints(hints);

    let src = new ZXing.HTMLCanvasElementLuminanceSource(canvas);
    let bmp = new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(src));
    let res = core.decode(bmp);
    if (res) return res.getText();

    for (const s of [0.85, 0.7, 0.55]) {
      const roi = cropCenter(canvas, s);
      src = new ZXing.HTMLCanvasElementLuminanceSource(roi);
      bmp = new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(src));
      res = core.decode(bmp);
      if (res) return res.getText();
    }
  } catch(e) {}
  return null;
}

function tryJsQR(canvas){
  if (!window.jsQR) return null;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  let img = ctx.getImageData(0,0,canvas.width,canvas.height);
  let q = jsQR(img.data, img.width, img.height, { inversionAttempts: 'attemptBoth' });
  if (q && q.data) return q.data;

  for (const s of [0.9, 0.75, 0.6]) {
    const roi = cropCenter(canvas, s);
    const d = roi.getContext('2d', { willReadFrequently: true }).getImageData(0,0,roi.width,roi.height);
    q = jsQR(d.data, d.width, d.height, { inversionAttempts: 'attemptBoth' });
    if (q && q.data) return q.data;
  }
  return null;
}

function decodeFromVideoFrame(){
  if (hitLocked || !videoEl?.videoWidth) return;

  const maxW = 1920;
  const scale = Math.min(1, maxW / videoEl.videoWidth);
  const canvas = document.createElement('canvas');
  canvas.width  = Math.floor(videoEl.videoWidth * scale);
  canvas.height = Math.floor(videoEl.videoHeight* scale);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);

  const z = tryZXing(canvas);
  if (z) return showHit(z);

  const j = tryJsQR(canvas);
  if (j) return showHit(j);

  setStatus('Scanning… fill the frame; avoid glare.');
}

// ===== permissions + devices =====
async function preflightPermission(){
  if (!secure) { setStatus('Needs HTTPS or http://localhost'); return false; }
  if (!navigator.mediaDevices?.getUserMedia) { setStatus('Camera API not available.'); return false; }
  try { await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' } }); return true; }
  catch (e) { setStatus('Camera permission denied or blocked.'); console.error(e); return false; }
}

async function populateCameras(){
  const devices = await navigator.mediaDevices.enumerateDevices();
  const cams = devices.filter(d => d.kind === 'videoinput');
  cameraSelect.innerHTML = '';
  if (cams.length === 0) { setStatus('No cameras found. Close Zoom/Meet if open.'); startBtn.disabled = true; return; }

  cams.forEach((d,i) => {
    const opt = document.createElement('option');
    opt.value = d.deviceId; opt.textContent = d.label || `Camera ${i+1}`;
    cameraSelect.appendChild(opt);
  });

  const front = cams.find(d => /front|user|facetime|macbook/i.test(d.label));
  const back  = cams.find(d => /back|rear|environment/i.test(d.label));
  currentDeviceId = (back || front || cams[0]).deviceId;
  cameraSelect.value = currentDeviceId;

  mirrorPreview(!!front || (!back && cams.length===1));
  startBtn.disabled = false;
  setStatus('Ready. Press Start and hold a QR ~10–20 cm from the camera.');
}

// ===== start/stop =====
async function start(){
  enableBtns(false);
  await stopAll();
  hitLocked = false;

  const id = cameraSelect.value || currentDeviceId;
  const constraints = { video: highResConstraints(id), audio: false };

  currentStream = await navigator.mediaDevices.getUserMedia(constraints);
  videoEl.srcObject = currentStream;
  videoEl.muted = true;
  videoEl.setAttribute('playsinline','');
  await videoEl.play().catch(()=>{});

  loopTimer = setInterval(decodeFromVideoFrame, 120);

  setTimeout(() => {
    const track = currentStream?.getVideoTracks?.[0];
    const caps = track?.getCapabilities?.();
    torchBtn.disabled = !(caps && 'torch' in caps);
  }, 600);
}

async function stopAll(){
  if (loopTimer) { clearInterval(loopTimer); loopTimer = null; }
  if (currentStream) {
    currentStream.getTracks().forEach(t => t.stop());
    currentStream = null;
  }
  if (torchBtn) torchBtn.disabled = true;
}

async function stop(){
  await stopAll();
  setStatus('Stopped.');
  enableBtns(true);
}

// ===== image upload decode (also normalized) =====
async function decodeImageFile(file){
  if (!file) return;
  setStatus('Decoding image…');
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    try {
      const maxW = 2400;
      const scale = Math.min(1, maxW / img.naturalWidth);
      const canvas = document.createElement('canvas');
      canvas.width  = Math.floor(img.naturalWidth  * scale);
      canvas.height = Math.floor(img.naturalHeight * scale);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

      const z = tryZXing(canvas) || tryJsQR(canvas);
      if (z) showHit(z);
      else setStatus('No QR found in image. Try cropping tighter.');
    } finally {
      URL.revokeObjectURL(url);
    }
  };
  img.onerror = () => { setStatus('Could not load image.'); URL.revokeObjectURL(url); };
  img.src = url;
}

// ===== UI wires (scanner) =====
window.addEventListener('DOMContentLoaded', async () => {
  enableBtns(false);
  if (await preflightPermission()) await populateCameras();
});
cameraSelect.addEventListener('change', (e) => { currentDeviceId = e.target.value; });
startBtn.addEventListener('click', start);
stopBtn.addEventListener('click', stop);
torchBtn.addEventListener('click', async () => {
  const track = currentStream?.getVideoTracks?.[0];
  const caps = track?.getCapabilities?.();
  if (!caps || !('torch' in caps)) return;
  torchOn = !torchOn;
  await track.applyConstraints({ advanced: [{ torch: torchOn }] });
  torchBtn.textContent = torchOn ? 'Torch off' : 'Toggle torch';
});
fileInput.addEventListener('change', (e) => decodeImageFile(e.target.files?.[0]));

openBtn.addEventListener('click', () => {
  const text = resultEl.textContent.trim();
  if (!text) return;
  const norm = normalizePayload(text);
  if (norm.href) window.open(norm.href, '_blank', 'noopener');
});
copyBtn.addEventListener('click', async () => {
  const norm = normalizePayload(resultEl.textContent.trim());
  if (!norm.raw) return;
  await navigator.clipboard.writeText(norm.raw);
  setStatus('Copied to clipboard ✅');
});

// ===== Tabs + Generator =====
function showScan(){
  scanTab?.classList.add('active');
  genTab?.classList.remove('active');
  if (scanSection) scanSection.style.display = 'block';
  if (genSection)  genSection.style.display  = 'none';
  // Optionally resume camera when switching back
  if (!currentStream && startBtn && !startBtn.disabled) start();
}
function showGen(){
  genTab?.classList.add('active');
  scanTab?.classList.remove('active');
  if (scanSection) scanSection.style.display = 'none';
  if (genSection)  genSection.style.display  = 'block';
  // Pause camera to save battery/privacy
  stopAll();
  enableBtns(true);
  setStatus('Camera paused while generating QR.');
}
scanTab?.addEventListener('click', showScan);
genTab?.addEventListener('click', showGen);

// Generator (uses public API for PNG output)
genBtn?.addEventListener('click', () => {
  const text = (qrText?.value || '').trim();
  if (!text) {
    if (qrOutput) qrOutput.innerHTML = '<p class="status">Please enter some text or a URL.</p>';
    return;
  }
  const size = qrSize?.value || '250';
  const url  = 'https://api.qrserver.com/v1/create-qr-code/?size=' + size + 'x' + size + '&data=' + encodeURIComponent(text);
  if (qrOutput) {
    qrOutput.innerHTML = `
      <img src="${url}" alt="Generated QR" width="${size}" height="${size}" style="border:1px solid #2a3853; border-radius:10px; padding:6px; background:#0f1729">
      <div style="margin-top:10px; display:flex; gap:10px; justify-content:center">
        <a id="qrDownload" href="${url}" download="qr-${size}.png" class="link">Download PNG</a>
        <button id="qrCopyLink" class="primary" type="button">Copy text</button>
      </div>
    `;
    document.getElementById('qrCopyLink')?.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(text); } catch {}
    });
  }
});
