/* =============================================
   SOUNDWAVE — app.js
   Full music player + IndexedDB persistence
   Songs & art survive app close / refresh
============================================= */

'use strict';

// ── IndexedDB Setup ────────────────────────
const DB_NAME    = 'soundwave-db';
const DB_VERSION = 1;
const STORE_SONGS = 'songs';

let db = null;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const database = e.target.result;
      if (!database.objectStoreNames.contains(STORE_SONGS)) {
        database.createObjectStore(STORE_SONGS, { keyPath: 'id' });
      }
    };
    req.onsuccess = (e) => { db = e.target.result; resolve(db); };
    req.onerror   = (e) => reject(e.target.error);
  });
}

function dbSaveSong(song) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_SONGS, 'readwrite');
    tx.objectStore(STORE_SONGS).put(song);
    tx.oncomplete = resolve;
    tx.onerror    = (e) => reject(e.target.error);
  });
}

function dbLoadAll() {
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_SONGS, 'readonly');
    const req = tx.objectStore(STORE_SONGS).getAll();
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror   = (e) => reject(e.target.error);
  });
}

function dbDeleteSong(id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_SONGS, 'readwrite');
    tx.objectStore(STORE_SONGS).delete(id);
    tx.oncomplete = resolve;
    tx.onerror    = (e) => reject(e.target.error);
  });
}

// ── State ──────────────────────────────────
let songs       = [];
let currentIdx  = -1;
let isPlaying   = false;
let isShuffle   = false;
let repeatMode  = 0;
let searchQuery = '';

const urlCache = new Map();

function getSongUrl(song) {
  if (!urlCache.has(song.id))
    urlCache.set(song.id, URL.createObjectURL(song.audioBlob));
  return urlCache.get(song.id);
}

function getArtUrl(song) {
  if (!song.artBlob) return null;
  const key = song.id + '_art';
  if (!urlCache.has(key))
    urlCache.set(key, URL.createObjectURL(song.artBlob));
  return urlCache.get(key);
}

function revokeUrls(song) {
  [song.id, song.id + '_art'].forEach(k => {
    if (urlCache.has(k)) { URL.revokeObjectURL(urlCache.get(k)); urlCache.delete(k); }
  });
}

const audio = document.getElementById('audio-player');

// ── DOM refs ───────────────────────────────
const fileInput    = document.getElementById('file-input');
const imgInput     = document.getElementById('img-input');
const songGrid     = document.getElementById('song-grid');
const emptyState   = document.getElementById('empty-state');
const searchInput  = document.getElementById('search-input');
const playerTitle  = document.getElementById('player-title');
const playerArtist = document.getElementById('player-artist');
const playerArt    = document.getElementById('player-art');
const playPauseBtn = document.getElementById('play-pause-btn');
const playIcon     = document.getElementById('play-icon');
const pauseIcon    = document.getElementById('pause-icon');
const prevBtn      = document.getElementById('prev-btn');
const nextBtn      = document.getElementById('next-btn');
const shuffleBtn   = document.getElementById('shuffle-btn');
const repeatBtn    = document.getElementById('repeat-btn');
const favBtn       = document.getElementById('fav-btn');
const progressBar   = document.getElementById('progress-bar');
const progressFill  = document.getElementById('progress-fill');
const progressThumb = document.getElementById('progress-thumb');
const curTime       = document.getElementById('cur-time');
const durTime       = document.getElementById('dur-time');
const volumeSlider  = document.getElementById('volume-slider');

// ── Helpers ────────────────────────────────
function formatTime(sec) {
  if (isNaN(sec) || sec < 0) return '0:00';
  return `${Math.floor(sec/60)}:${Math.floor(sec%60).toString().padStart(2,'0')}`;
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2,6);
}

function getAudioDuration(blob) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const tmp = new Audio(url);
    tmp.addEventListener('loadedmetadata', () => { URL.revokeObjectURL(url); resolve(tmp.duration); });
    tmp.addEventListener('error',          () => { URL.revokeObjectURL(url); resolve(0); });
    tmp.src = url;
  });
}

// ── File Upload ────────────────────────────
fileInput.addEventListener('change', async (e) => {
  const files = Array.from(e.target.files);
  for (const file of files) {
    if (!file.type.startsWith('audio/')) continue;
    const nameRaw  = file.name.replace(/\.[^/.]+$/, '');
    const parts    = nameRaw.split(' - ');
    const title    = parts.length >= 2 ? parts.slice(1).join(' - ').trim() : nameRaw;
    const artist   = parts.length >= 2 ? parts[0].trim() : 'Unknown Artist';
    const duration = await getAudioDuration(file);
    const song = { id: uid(), name: title, artist, duration, audioBlob: file, artBlob: null, fav: false, addedAt: Date.now() };
    songs.push(song);
    await dbSaveSong(song);
  }
  fileInput.value = '';
  renderGrid();
});

// ── Art Upload ─────────────────────────────
imgInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const idx  = +imgInput.dataset.target;
  const song = songs[idx];
  const artKey = song.id + '_art';
  if (urlCache.has(artKey)) { URL.revokeObjectURL(urlCache.get(artKey)); urlCache.delete(artKey); }
  song.artBlob = file;
  await dbSaveSong(song);
  imgInput.value = '';
  renderGrid();
  if (currentIdx === idx) updatePlayerArt();
});

// ── Render Grid ────────────────────────────
const gradients = [
  'linear-gradient(135deg,#1e1b4b,#4c1d95)',
  'linear-gradient(135deg,#1a1a2e,#16213e)',
  'linear-gradient(135deg,#0f172a,#1e3a5f)',
  'linear-gradient(135deg,#1c0533,#4a044e)',
  'linear-gradient(135deg,#0c1a1a,#064e3b)',
];

function renderGrid() {
  const q        = searchQuery.toLowerCase();
  const filtered = songs.filter(s => s.name.toLowerCase().includes(q) || s.artist.toLowerCase().includes(q));

  emptyState.style.display = songs.length === 0 ? 'flex' : 'none';
  songGrid.style.display   = songs.length === 0 ? 'none' : 'grid';
  songGrid.innerHTML = '';

  filtered.forEach((song) => {
    const realIdx  = songs.indexOf(song);
    const isActive = realIdx === currentIdx;
    const artUrl   = getArtUrl(song);
    const card     = document.createElement('div');
    card.className = 'song-card' + (isActive ? ' active' : '');
    card.dataset.idx = realIdx;

    card.innerHTML = `
      <div class="card-art">
        <div class="card-art-inner" style="background:${gradients[realIdx % gradients.length]}">
          ${artUrl ? `<img src="${artUrl}" alt="art"/>` : `<div class="no-img-icon"><svg viewBox="0 0 24 24"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg></div>`}
          <div class="play-overlay">
            ${isActive && isPlaying
              ? `<div class="card-equalizer"><span></span><span></span><span></span><span></span></div>`
              : `<svg viewBox="0 0 24 24" width="36" height="36"><polygon points="5 3 19 12 5 21 5 3"/></svg>`}
          </div>
          <button class="cam-btn" data-idx="${realIdx}" title="Change art">
            <svg viewBox="0 0 24 24"><path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/><circle cx="12" cy="13" r="4"/></svg>
          </button>
        </div>
      </div>
      <div class="card-body">
        <div>
          <div class="card-title">${song.name}</div>
          <div class="card-meta">${song.artist}</div>
        </div>
        <div class="card-actions">
          <span class="card-duration">${formatTime(song.duration)}</span>
          <div style="display:flex;gap:4px">
            <button class="card-fav${song.fav ? ' active' : ''}" data-idx="${realIdx}" title="Favourite">
              <svg viewBox="0 0 24 24"><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/></svg>
            </button>
            <button class="card-delete" data-idx="${realIdx}" title="Remove">
              <svg viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>
            </button>
          </div>
        </div>
      </div>`;

    card.addEventListener('click', (e) => { if (!e.target.closest('button')) playSong(realIdx); });
    songGrid.appendChild(card);
  });

  songGrid.querySelectorAll('.card-fav').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const idx = +btn.dataset.idx;
      songs[idx].fav = !songs[idx].fav;
      await dbSaveSong(songs[idx]);
      renderGrid(); updatePlayerFavBtn();
    });
  });

  songGrid.querySelectorAll('.card-delete').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const idx = +btn.dataset.idx;
      revokeUrls(songs[idx]);
      await dbDeleteSong(songs[idx].id);
      songs.splice(idx, 1);
      if (currentIdx === idx) stopPlayer();
      else if (currentIdx > idx) currentIdx--;
      renderGrid();
    });
  });

  songGrid.querySelectorAll('.cam-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      imgInput.dataset.target = btn.dataset.idx;
      imgInput.click();
    });
  });
}

// ── Playback ───────────────────────────────
function playSong(idx) {
  if (idx < 0 || idx >= songs.length) return;
  currentIdx   = idx;
  audio.src    = getSongUrl(songs[idx]);
  audio.volume = +volumeSlider.value;
  audio.play().then(() => { isPlaying = true; updatePlayPauseUI(); updatePlayerInfo(); renderGrid(); })
               .catch(err => console.warn('Play error:', err));
}

function stopPlayer() {
  audio.pause(); audio.src = '';
  isPlaying = false; currentIdx = -1;
  updatePlayPauseUI();
  playerTitle.textContent  = 'No track selected';
  playerArtist.textContent = '—';
  playerArt.innerHTML = `<div class="art-placeholder"><svg viewBox="0 0 24 24" width="22" height="22"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg></div>`;
  playerArt.classList.remove('spinning');
  progressFill.style.width = '0%';
  curTime.textContent = '0:00'; durTime.textContent = '0:00';
}

function updatePlayerInfo() {
  if (currentIdx < 0) return;
  playerTitle.textContent  = songs[currentIdx].name;
  playerArtist.textContent = songs[currentIdx].artist;
  updatePlayerArt(); updatePlayerFavBtn();
}

function updatePlayerArt() {
  if (currentIdx < 0) return;
  const artUrl = getArtUrl(songs[currentIdx]);
  playerArt.innerHTML = artUrl
    ? `<img src="${artUrl}" alt="art"/>`
    : `<div class="art-placeholder"><svg viewBox="0 0 24 24" width="22" height="22"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg></div>`;
  playerArt.classList.toggle('spinning', isPlaying);
}

function updatePlayPauseUI() {
  playIcon.style.display  = isPlaying ? 'none'  : 'block';
  pauseIcon.style.display = isPlaying ? 'block' : 'none';
  playerArt.classList.toggle('spinning', isPlaying);
}

function updatePlayerFavBtn() {
  if (currentIdx < 0) { favBtn.classList.remove('active'); return; }
  favBtn.classList.toggle('active', songs[currentIdx].fav);
}

// ── Controls ───────────────────────────────
playPauseBtn.addEventListener('click', () => {
  if (currentIdx === -1) { if (songs.length) playSong(0); return; }
  if (isPlaying) { audio.pause(); isPlaying = false; }
  else           { audio.play();  isPlaying = true;  }
  updatePlayPauseUI(); renderGrid();
});

nextBtn.addEventListener('click', playNext);
prevBtn.addEventListener('click', playPrev);

function playNext() {
  if (!songs.length) return;
  if (repeatMode === 2) { audio.currentTime = 0; audio.play(); return; }
  let next = isShuffle ? Math.floor(Math.random() * songs.length) : currentIdx + 1;
  if (next >= songs.length) next = repeatMode === 1 ? 0 : -1;
  if (next === -1) { stopPlayer(); return; }
  playSong(next);
}

function playPrev() {
  if (!songs.length) return;
  if (audio.currentTime > 3) { audio.currentTime = 0; return; }
  playSong((currentIdx - 1 + songs.length) % songs.length);
}

shuffleBtn.addEventListener('click', () => { isShuffle = !isShuffle; shuffleBtn.classList.toggle('active', isShuffle); });

repeatBtn.addEventListener('click', () => {
  repeatMode = (repeatMode + 1) % 3;
  repeatBtn.classList.toggle('active', repeatMode > 0);
  repeatBtn.title = ['Repeat Off','Repeat All','Repeat One'][repeatMode];
});

favBtn.addEventListener('click', async () => {
  if (currentIdx < 0) return;
  songs[currentIdx].fav = !songs[currentIdx].fav;
  await dbSaveSong(songs[currentIdx]);
  updatePlayerFavBtn(); renderGrid();
});

// ── Audio Events ───────────────────────────
audio.addEventListener('ended', () => { isPlaying = false; playNext(); });

audio.addEventListener('timeupdate', () => {
  if (!audio.duration) return;
  const pct = (audio.currentTime / audio.duration) * 100;
  progressFill.style.width = pct + '%';
  progressThumb.style.setProperty('--pct', pct + '%');
  curTime.textContent = formatTime(audio.currentTime);
});

audio.addEventListener('loadedmetadata', () => { durTime.textContent = formatTime(audio.duration); });
audio.addEventListener('play',  () => { isPlaying = true;  updatePlayPauseUI(); });
audio.addEventListener('pause', () => { isPlaying = false; updatePlayPauseUI(); });

// ── Seek ───────────────────────────────────
let isSeeking = false;
function seekTo(clientX) {
  const rect = progressBar.getBoundingClientRect();
  const pct  = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  if (audio.duration) audio.currentTime = pct * audio.duration;
}
progressBar.addEventListener('mousedown',  (e) => { isSeeking = true;  seekTo(e.clientX); });
document.addEventListener('mousemove',     (e) => { if (isSeeking) seekTo(e.clientX); });
document.addEventListener('mouseup',       ()  => { isSeeking = false; });
progressBar.addEventListener('touchstart', (e) => { isSeeking = true;  seekTo(e.touches[0].clientX); }, { passive: true });
document.addEventListener('touchmove',     (e) => { if (isSeeking) seekTo(e.touches[0].clientX); },    { passive: true });
document.addEventListener('touchend',      ()  => { isSeeking = false; });

// ── Volume ─────────────────────────────────
volumeSlider.addEventListener('input', () => { audio.volume = +volumeSlider.value; });

// ── Search ─────────────────────────────────
searchInput.addEventListener('input', (e) => { searchQuery = e.target.value; renderGrid(); });

// ── Keyboard ───────────────────────────────
document.addEventListener('keydown', (e) => {
  if (['INPUT','TEXTAREA'].includes(document.activeElement.tagName)) return;
  switch (e.code) {
    case 'Space':      e.preventDefault(); playPauseBtn.click(); break;
    case 'ArrowRight': if (audio.duration) audio.currentTime = Math.min(audio.duration, audio.currentTime + 5); break;
    case 'ArrowLeft':  audio.currentTime = Math.max(0, audio.currentTime - 5); break;
    case 'ArrowUp':    volumeSlider.value = Math.min(1, +volumeSlider.value + 0.1); audio.volume = +volumeSlider.value; break;
    case 'ArrowDown':  volumeSlider.value = Math.max(0, +volumeSlider.value - 0.1); audio.volume = +volumeSlider.value; break;
    case 'KeyN':       playNext(); break;
    case 'KeyP':       playPrev(); break;
  }
});

// ── PWA Install ────────────────────────────
let deferredPrompt;
const installBtn = document.getElementById('install-btn');

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault(); deferredPrompt = e;
  if (installBtn) installBtn.style.display = 'flex';
});

if (installBtn) {
  installBtn.addEventListener('click', async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    installBtn.style.display = 'none';
  });
}

window.addEventListener('appinstalled', () => {
  if (installBtn) installBtn.style.display = 'none';
  deferredPrompt = null;
});

// ── Service Worker ─────────────────────────
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js')
      .then(reg => console.log('✅ SW registered:', reg.scope))
      .catch(err => console.error('❌ SW failed:', err));
  });
}

// ── Init ───────────────────────────────────
async function init() {
  await openDB();
  const saved = await dbLoadAll();
  saved.sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0));
  songs = saved;
  renderGrid();
  console.log(`✅ Loaded ${songs.length} song(s) from IndexedDB`);
}

init();