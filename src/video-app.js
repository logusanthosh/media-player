import { deleteMedia, readAllMedia, readStore, saveMedia, writeStore } from './db.js';
import { readEmbeddedMetadata } from './metadata.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const video = $('#video-element');
const audio = $('#audio-element');
const MEDIA_STORE_KEY = 'items';
const AUDIO_EXTENSIONS = /\.(mp3|wav|flac|aac|m4a|ogg|opus|oga)$/i;
const VIDEO_EXTENSIONS = /\.(mp4|webm|mov|mkv|avi|m4v|3gp|ogv|mpg|mpeg|m2v)$/i;
const VIDEO_OPTIONS = [
  { id: 'night-mode', label: 'Night Mode' },
  { id: 'customise-items', label: 'Customise Items' },
  { id: 'sleep-timer', label: 'Sleep Timer' },
  { id: 'playback-speed', label: 'Playback Speed' },
  { id: 'screenshot', label: 'Screenshot' },
  { id: 'background-play', label: 'Background Play' },
  { id: 'screen-rotation', label: 'Screen Rotation' }
];

const state = {
  items: [],
  videos: [],
  audios: [],
  recent: [],
  favorites: new Set(),
  playlists: [],
  playlistId: '',
  view: 'videos',
  search: '',
  currentVideoId: '',
  currentAudioId: '',
  videoQueue: [],
  audioQueue: [],
  scannedFolders: [],
  scanBusy: false,
  scanProgress: '',
  scanSummary: '',
  folderSelectionMode: 'manual',
  audioVolume: 0.8,
  audioMuted: false,
  videoRotation: 0,
  videoSpeed: 1,
  visibleVideoOptions: VIDEO_OPTIONS.map(option => option.id),
  nightMode: false,
  lockScreenControls: false,
  backgroundPlay: false,
  sleepTimer: 0,
  sleepTimerEndsAt: 0,
  sleepTimerMinutes: 0,
  userSeeking: false,
  lastSavedPosition: 0,
  playlistEditId: ''
};

let deferredInstall = null;
let confirmAction = null;
let toastTimer = 0;
let videoControlsHideTimer = 0;
let videoSeekPointerId = null;

function videoControlsArePinned() {
  return video.paused || videoSeekPointerId !== null;
}

function hideVideoControls() {
  clearTimeout(videoControlsHideTimer);
  videoControlsHideTimer = 0;
  if (!$('#video-player').open || videoControlsArePinned()) return;
  $('#video-player').classList.add('controls-hidden');
}

function showVideoControls() {
  clearTimeout(videoControlsHideTimer);
  videoControlsHideTimer = 0;
  if (!$('#video-player').open) return;
  $('#video-player').classList.remove('controls-hidden');
  if (!videoControlsArePinned()) {
    videoControlsHideTimer = setTimeout(hideVideoControls, 3000);
  }
}

function toast(message) {
  $('.toast')?.remove();
  const notice = document.createElement('div');
  notice.className = 'toast';
  notice.textContent = message;
  document.body.append(notice);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => notice.remove(), 3200);
}

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return '0:00';
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}

function formatRemaining(seconds) {
  return `-${formatTime(seconds)}`;
}

function titleFromName(name) {
  return name.replace(/\.[^.]+$/, '').trim() || 'Untitled video';
}

function itemId(file, kind) {
  const identity = `${encodeURIComponent(file.name)}-${file.size}-${file.lastModified}`;
  return kind === 'audio' ? identity : `video:${identity}`;
}

function quotaError(message) {
  const error = new Error(message);
  error.name = 'QuotaExceededError';
  return error;
}

async function ensureStorageAvailable(size) {
  const estimate = await navigator.storage?.estimate?.();
  if (estimate && Number.isFinite(estimate.quota) && Number.isFinite(estimate.usage) &&
      estimate.quota - estimate.usage < size) {
    throw quotaError('There is not enough device storage for this file.');
  }
}

async function requestPersistentStorage() {
  const storage = navigator.storage;
  if (!storage) return;
  try {
    if (typeof storage.persist === 'function') {
      const persisted = await storage.persist();
      if (!persisted) console.info('Persistent storage was not granted for SONIQ.');
    }
    if (typeof storage.estimate === 'function') {
      const estimate = await storage.estimate();
      if (Number.isFinite(estimate.quota) && Number.isFinite(estimate.usage)) {
        console.info(`SONIQ storage: ${estimate.usage} of ${estimate.quota} bytes used.`);
      }
    }
  } catch (error) {
    console.warn('Could not check or request persistent storage:', error);
  }
}

function mediaSaveError(error, fileName) {
  if (error?.name === 'QuotaExceededError' || error?.name === 'NS_ERROR_DOM_QUOTA_REACHED') {
    return `Not enough device storage to save "${fileName}". Free up space and try again.`;
  }
  return `Could not save "${fileName}" to this device. ${error?.message ?? 'Please try again.'}`;
}

function kindOf(file) {
  const type = typeof file?.type === 'string' ? file.type.split(';', 1)[0].trim().toLowerCase() : '';
  const name = typeof file?.name === 'string' ? file.name : '';
  if (type.startsWith('video/') || VIDEO_EXTENSIONS.test(name)) return 'video';
  if (type.startsWith('audio/') || AUDIO_EXTENSIONS.test(name)) return 'audio';
  return '';
}

function createScanReport() {
  const mediaCounts = () => ({ discovered: 0, imported: 0, skipped: 0, failed: 0 });
  return {
    audio: mediaCounts(),
    video: mediaCounts(),
    unsupported: 0,
    scanErrors: 0,
    errors: []
  };
}

function recordScanFailure(report, kind, path, error) {
  if (kind) report[kind].failed++;
  else report.scanErrors++;
  const detail = String(error?.message ?? 'Unknown error').replace(/[.\s]+$/, '');
  report.errors.push(`${path}: ${detail}`);
}

function mergeScanReports(target, source) {
  for (const kind of ['audio', 'video']) {
    for (const count of ['discovered', 'imported', 'skipped', 'failed']) {
      target[kind][count] += source[kind][count];
    }
  }
  target.unsupported += source.unsupported;
  target.scanErrors += source.scanErrors;
  target.errors.push(...source.errors);
}

function formatScanReport(report, note = '') {
  const lines = ['audio', 'video'].map(kind => {
    const counts = report[kind];
    const label = kind === 'audio' ? 'Audio' : 'Video';
    return `${label}: ${counts.discovered} discovered, ${counts.imported} imported, ${counts.skipped} skipped, ${counts.failed} failed`;
  });
  if (report.unsupported) lines.push(`Unsupported files skipped: ${report.unsupported}`);
  if (report.scanErrors) lines.push(`Folder access errors: ${report.scanErrors}`);
  if (report.errors.length) lines.push(`Errors: ${report.errors.slice(0, 2).join('; ')}`);
  if (note) lines.push(note);
  const completion = report.scanErrors || report.audio.failed || report.video.failed
    ? 'Scan completed with errors'
    : 'Scan completed';
  return `${completion}. ${lines.join('. ')}`;
}

function renderScanStatus() {
  const message = state.scanProgress || state.scanSummary;
  return message
    ? `<p class="scan-status" role="status" aria-live="polite">${escapeHtml(message)}</p>`
    : '';
}

function rememberAudioVolume() {
  writeStore('settings', 'audio-volume', state.audioVolume)
    .catch(error => console.error('Could not save audio volume:', error));
}

function persistLibrary() {
  const metadata = state.items.map(({ file, url, artworkUrl, ...item }) => item);
  return writeStore('library', MEDIA_STORE_KEY, metadata);
}

function itemById(id) {
  return state.items.find(item => item.id === id);
}

function filteredItems(kind = '') {
  const term = state.search.toLocaleLowerCase();
  return state.items.filter(item => (!kind || item.kind === kind) &&
    (!term || `${item.title} ${item.artist ?? ''} ${item.album ?? ''} ${item.fileName}`.toLocaleLowerCase().includes(term)));
}

function addButton(label = 'Open files') {
  return `<button class="button button-primary" data-action="open-files"><span aria-hidden="true">＋</span>${label}</button>`;
}

function emptyState(title, copy, button = true) {
  return `<div class="empty-library"><div class="empty-symbol" aria-hidden="true">▶</div><h2>${escapeHtml(title)}</h2><p>${escapeHtml(copy)}</p>${button ? addButton() : ''}</div>`;
}

function videoCard(item) {
  const needsRelink = !item.url;
  const status = item.scanMissing
    ? 'Not found in scanned folder; saved copy retained'
    : needsRelink ? 'Saved copy unavailable' : 'Video';
  return `<article class="video-card" tabindex="0" role="button" data-open-video="${escapeHtml(item.id)}" aria-label="Play ${escapeHtml(item.title)}">
    <div class="video-thumb"><span class="thumb-symbol" aria-hidden="true">▶</span>${item.duration ? `<span class="duration-badge">${formatTime(item.duration)}</span>` : ''}</div>
    <div class="video-card-copy"><div><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(status)}</p></div><button class="icon-button media-delete" data-action="delete-media" data-id="${escapeHtml(item.id)}" aria-label="Delete ${escapeHtml(item.title)} from library" title="Delete from library">×</button></div>
  </article>`;
}

function videoGrid(items, title, copy) {
  if (!items.length) return emptyState(title, copy);
  return `<div class="video-grid">${items.map(videoCard).join('')}</div>`;
}

function audioChip(item) {
  return `<button class="audio-chip" data-play-audio="${escapeHtml(item.id)}" aria-label="Play ${escapeHtml(item.title)}">
    <span class="audio-chip-icon" aria-hidden="true">♫</span>
    <span class="audio-chip-copy"><b>${escapeHtml(item.title)}</b><small>${escapeHtml(item.scanMissing ? 'Not found in scanned folder; saved copy retained' : item.artist || 'Unknown artist')}</small></span>
  </button>`;
}

function renderVideos() {
  const videos = filteredItems('video');
  const recentVideos = state.recent.map(itemById).filter(item => item?.kind === 'video').slice(0, 4);
  const unlinked = state.videos.some(item => !item.url);
  return `<div class="welcome"><div><p class="overline">SONIQ · LOCAL VIDEO PLAYER</p><h1>Your videos</h1><p>Scan folders you choose. SONIQ only reads media you authorize, and your files stay on this device.</p></div>
    <div class="library-actions"><button class="button button-primary" data-action="scan-folders" ${state.scanBusy ? 'disabled' : ''}>Scan Device Folders</button><button class="button button-light" data-action="rescan-folders" ${state.scanBusy ? 'disabled' : ''}>Rescan Folders</button></div></div>
    ${renderScanStatus()}
    ${unlinked ? '<p class="library-note">Some older library entries do not have a saved file yet. Select those files once to store them on this device.</p>' : ''}
    ${videoGrid(videos, state.search ? 'No matching videos' : 'Your video library is ready', state.search ? 'Try another search.' : 'Open local video files to start watching. SONIQ never uploads your media.')}
    <section class="section"><div class="section-heading"><h2>Audio</h2><button data-view="audio">Open audio&nbsp; →</button></div>
      ${state.audios.length ? `<div class="audio-preview">${state.audios.slice(0, 4).map(audioChip).join('')}</div>` : '<p class="section-empty">Your audio library will appear here.</p>'}
    </section>
    ${recentVideos.length ? `<section class="section"><div class="section-heading"><h2>Recently played</h2><button data-view="recent">View all&nbsp; →</button></div>${videoGrid(recentVideos, '', '')}</section>` : ''}`;
}

function playlistTools() {
  return `<div class="playlist-tools">
    <select id="playlist-select" aria-label="Select audio playlist">
      <option value="">All audio</option>
      ${state.playlists.map(list => `<option value="${escapeHtml(list.id)}" ${list.id === state.playlistId ? 'selected' : ''}>${escapeHtml(list.name)}</option>`).join('')}
    </select>
    <button class="small-action" data-action="new-playlist">＋ Playlist</button>
    ${state.playlistId ? `<button class="small-action" data-action="rename-playlist">Rename</button><button class="small-action" data-action="delete-playlist">Delete</button>` : ''}
  </div>`;
}

function renderAudio() {
  const allAudio = filteredItems('audio');
  const selectedPlaylist = state.playlists.find(list => list.id === state.playlistId);
  const songs = selectedPlaylist
    ? selectedPlaylist.songIds.map(itemById).filter(item => item?.kind === 'audio' && allAudio.includes(item))
    : allAudio;
  const rows = songs.map(item => `<div class="audio-row" data-audio-row="${escapeHtml(item.id)}">
    <button class="icon-button audio-play-row" data-play-audio="${escapeHtml(item.id)}" aria-label="Play ${escapeHtml(item.title)}">${item.id === state.currentAudioId && !audio.paused ? 'Ⅱ' : '▶'}</button>
    <span class="audio-row-title"><b>${escapeHtml(item.title)}</b><small>${escapeHtml(item.scanMissing ? 'Not found in scanned folder; saved copy retained' : item.artist || 'Unknown artist')}</small></span>
    <span class="audio-meta">${escapeHtml(item.album || '')}</span><span class="audio-duration">${formatTime(item.duration)}</span>
    <button class="icon-button" data-action="favorite" data-id="${escapeHtml(item.id)}" aria-label="Favorite ${escapeHtml(item.title)}">${state.favorites.has(item.id) ? '♥' : '♡'}</button>
    ${selectedPlaylist
      ? `<button class="icon-button" data-action="remove-from-playlist" data-id="${escapeHtml(item.id)}" aria-label="Remove ${escapeHtml(item.title)} from playlist">−</button>`
      : `<button class="icon-button" data-action="add-to-playlist" data-id="${escapeHtml(item.id)}" aria-label="Add ${escapeHtml(item.title)} to playlist">＋</button>`}
    <button class="icon-button media-delete" data-action="delete-media" data-id="${escapeHtml(item.id)}" aria-label="Delete ${escapeHtml(item.title)} from library" title="Delete from library">×</button>
  </div>`).join('');
  return `<div class="page-heading"><div><p class="overline">SECONDARY PLAYER</p><h1>Audio</h1><p>Local tracks and your playlists.</p></div><div class="audio-page-controls">${addButton()}</div></div>
    ${playlistTools()}
    ${renderScanStatus()}
    ${state.audios.some(item => !item.url) ? '<p class="library-note">Some older audio entries do not have a saved file yet. Select those files once to store them on this device.</p>' : ''}
    ${songs.length ? `<div class="audio-list">${rows}</div>` : emptyState(state.search ? 'No matching audio' : selectedPlaylist ? 'This playlist is empty' : 'No audio files yet', state.search ? 'Try another search.' : 'Open audio files from your device. They stay local.', !state.search)}`;
}

async function removeMediaItem(id) {
  const item = itemById(id);
  if (!item) return;
  try {
    await deleteMedia(id, MEDIA_STORE_KEY);
    if (state.currentVideoId === id) {
      state.currentVideoId = '';
      video.pause();
      video.removeAttribute('src');
      video.load();
      if ($('#video-player').open) $('#video-player').close();
    }
    if (state.currentAudioId === id) {
      state.currentAudioId = '';
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    }
    if (item.url) URL.revokeObjectURL(item.url);
    if (item.artworkUrl) URL.revokeObjectURL(item.artworkUrl);
    state.items = state.items.filter(entry => entry.id !== id);
    state.videos = state.videos.filter(entry => entry.id !== id);
    state.audios = state.audios.filter(entry => entry.id !== id);
    state.recent = state.recent.filter(entry => entry !== id);
    state.favorites.delete(id);
    state.playlists.forEach(list => {
      list.songIds = (list.songIds ?? []).filter(songId => songId !== id);
    });
    state.videoQueue = state.videoQueue.filter(entry => entry !== id);
    state.audioQueue = state.audioQueue.filter(entry => entry !== id);
    render();
    toast(`Removed "${item.fileName || item.title}" from this device.`);
  } catch (error) {
    const fileName = item.fileName || item.title;
    console.error(`Could not remove local media "${fileName}":`, error);
    toast(`Could not delete "${fileName}" from this device. ${error?.message ?? 'Please try again.'}`);
  }
}

function renderRecent() {
  const recentVideos = state.recent.map(itemById).filter(item => item?.kind === 'video' && (!state.search || item.title.toLocaleLowerCase().includes(state.search.toLocaleLowerCase())));
  const recentAudio = state.recent.map(itemById).filter(item => item?.kind === 'audio' && (!state.search || item.title.toLocaleLowerCase().includes(state.search.toLocaleLowerCase())));
  return `<div class="page-heading"><div><p class="overline">YOUR WATCH HISTORY</p><h1>Recently played</h1><p>Only saved on this device.</p></div></div>
    <section class="section"><div class="section-heading"><h2>Videos</h2></div>${videoGrid(recentVideos, 'Nothing here yet', 'Videos you play will appear here.')}</section>
    <section class="section"><div class="section-heading"><h2>Audio</h2><button data-view="audio">Open audio&nbsp; →</button></div>${recentAudio.length ? `<div class="audio-preview">${recentAudio.map(audioChip).join('')}</div>` : '<p class="section-empty">Audio you play will appear here.</p>'}</section>`;
}

function render() {
  const main = $('#main-content');
  const pages = { videos: renderVideos, audio: renderAudio, recent: renderRecent };
  main.innerHTML = (pages[state.view] ?? renderVideos)();
  $$('.nav-link').forEach(button => button.classList.toggle('active', button.dataset.view === state.view));
  $('#search').value = state.search;
  $('#audio-dock').hidden = !state.currentAudioId;
  document.body.classList.toggle('has-audio-dock', Boolean(state.currentAudioId));
  renderAudioDock();
  updateVideoBackgroundDock();
}

function renderAudioDock() {
  const current = itemById(state.currentAudioId);
  if (!current) return;
  $('#dock-title').textContent = current.title;
  $('#dock-artist').textContent = current.artist || 'Unknown artist';
  $('#audio-play').textContent = audio.paused ? '▶' : 'Ⅱ';
  $('#audio-play').setAttribute('aria-label', audio.paused ? 'Play audio' : 'Pause audio');
  $('#audio-volume').value = state.audioVolume;
  updateAudioProgress();
}

function updateAudioProgress() {
  const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
  const current = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
  $('#audio-current').textContent = formatTime(current);
  $('#audio-duration').textContent = formatTime(duration);
  if (!state.userSeeking) $('#audio-seek').value = duration ? current / duration * 1000 : 0;
}

function updateVideoProgress() {
  const duration = Number.isFinite(video.duration) ? video.duration : 0;
  const current = Number.isFinite(video.currentTime) ? video.currentTime : 0;
  $('#video-current').textContent = formatTime(current);
  $('#video-remaining').textContent = formatRemaining(Math.max(0, duration - current));
  if (!state.userSeeking) $('#video-seek').value = duration ? current / duration * 1000 : 0;
  $('#video-play').textContent = video.paused ? '▶' : 'Ⅱ';
  $('#video-play').setAttribute('aria-label', video.paused ? 'Play' : 'Pause');
  $('#video-previous').disabled = state.videoQueue.indexOf(state.currentVideoId) <= 0 && current <= 3;
  $('#video-next').disabled = state.videoQueue.indexOf(state.currentVideoId) < 0 ||
    state.videoQueue.indexOf(state.currentVideoId) >= state.videoQueue.length - 1;
  updateSleepTimerLabel();
}

function showVideoMessage(message) {
  const element = $('#video-message');
  element.textContent = message;
  element.hidden = false;
}

function hideVideoMessage() {
  $('#video-message').hidden = true;
}

function updateVideoLayout() {
  const stage = $('#video-stage');
  const bounds = stage.getBoundingClientRect();
  if (!bounds.width || !bounds.height) return;
  const rotated = state.videoRotation % 180 !== 0;
  video.style.width = `${rotated ? bounds.height : bounds.width}px`;
  video.style.height = `${rotated ? bounds.width : bounds.height}px`;
  video.style.objectFit = 'contain';
  video.style.transform = `translate(-50%, -50%) rotate(${state.videoRotation}deg)`;
}

function rotateVideo(degrees) {
  state.videoRotation = (state.videoRotation + degrees + 360) % 360;
  const button = $('#rotation-button');
  button.textContent = `Screen Rotation · ${state.videoRotation}°`;
  button.setAttribute('aria-label', `Rotate video; currently ${state.videoRotation} degrees`);
  updateVideoLayout();
}

function updatePlayerSettings() {
  $('#video-player').classList.toggle('night-mode', state.nightMode);
  $('#night-mode-button').setAttribute('aria-pressed', String(state.nightMode));
  $('#lock-screen-button').setAttribute('aria-pressed', String(state.lockScreenControls));
  $('#lock-screen-button').setAttribute('aria-label', `${state.lockScreenControls ? 'Disable' : 'Enable'} lock screen controls`);
  $('#background-play-button').setAttribute('aria-pressed', String(state.backgroundPlay));
  $('#video-speed').value = String(state.videoSpeed);
  $$('[data-video-option]').forEach(option => {
    option.hidden = option.dataset.videoOption !== 'customise-items' &&
      !state.visibleVideoOptions.includes(option.dataset.videoOption);
  });
  updateVideoBackgroundDock();
}

function updateVideoBackgroundDock() {
  const dock = $('#video-background-dock');
  const current = itemById(state.currentVideoId);
  const visible = Boolean(current && state.backgroundPlay && !$('#video-player').open);
  dock.hidden = !visible;
  if (visible) $('#video-background-title').textContent = current.title;
}

function renderCustomiseItems() {
  $('#customise-items-list').innerHTML = VIDEO_OPTIONS
    .filter(option => option.id !== 'customise-items')
    .map(option => `<label class="customise-item"><input type="checkbox" name="video-option" value="${option.id}" ${state.visibleVideoOptions.includes(option.id) ? 'checked' : ''}><span>${option.label}</span></label>`)
    .join('');
}

function openCustomiseItems() {
  renderCustomiseItems();
  $('#customise-dialog').showModal();
}

function configureMediaSession() {
  const mediaSession = navigator.mediaSession;
  if (!mediaSession) return;
  const current = itemById(state.currentVideoId);
  const enabled = Boolean((state.lockScreenControls || state.backgroundPlay) && current);
  if (enabled && typeof MediaMetadata === 'function') {
    mediaSession.metadata = new MediaMetadata({ title: current.fileName || current.title, artist: 'SONIQ' });
  } else {
    mediaSession.metadata = null;
  }
  const handlers = {
    play: () => toggleVideoPlay(),
    pause: () => video.pause(),
    previoustrack: () => playPreviousVideo(),
    nexttrack: () => playNextVideo()
  };
  for (const [action, handler] of Object.entries(handlers)) {
    try {
      mediaSession.setActionHandler(action, enabled ? handler : null);
    } catch (error) {
      console.info(`Lock screen ${action} controls are not supported:`, error);
    }
  }
  mediaSession.playbackState = video.paused ? 'paused' : 'playing';
}

function setVideoSetting(key, value) {
  writeStore('settings', key, value)
    .catch(error => {
      console.error(`Could not save video ${key}:`, error);
      toast(`Could not save this player setting. ${error?.message ?? 'Please try again.'}`);
    });
}

function toggleNightMode() {
  state.nightMode = !state.nightMode;
  updatePlayerSettings();
  setVideoSetting('video-night-mode', state.nightMode);
}

function toggleLockScreenControls() {
  if (!navigator.mediaSession) {
    toast('Lock screen controls are not supported by this browser.');
    return;
  }
  state.lockScreenControls = !state.lockScreenControls;
  updatePlayerSettings();
  configureMediaSession();
  setVideoSetting('video-lock-screen-controls', state.lockScreenControls);
  toast(state.lockScreenControls ? 'Lock screen controls enabled where supported.' : 'Lock screen controls disabled.');
}

function toggleBackgroundPlay() {
  state.backgroundPlay = !state.backgroundPlay;
  updatePlayerSettings();
  configureMediaSession();
  setVideoSetting('video-background-play', state.backgroundPlay);
  if (!state.backgroundPlay && !$('#video-player').open) video.pause();
  toast(state.backgroundPlay
    ? navigator.mediaSession
      ? 'Playback can continue when you leave SONIQ, where your browser allows it.'
      : 'Background playback is enabled; lock screen controls are unavailable in this browser.'
    : 'Background playback disabled.');
}

function captureVideoScreenshot() {
  if (!video.videoWidth || !video.videoHeight) {
    toast('A screenshot is not available until the video has a picture.');
    return;
  }
  try {
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob(blob => {
      if (!blob) {
        toast('The video frame could not be saved as an image.');
        return;
      }
      const link = document.createElement('a');
      const name = (itemById(state.currentVideoId)?.fileName || 'video')
        .replace(/\.[^.]+$/, '')
        .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_');
      link.href = URL.createObjectURL(blob);
      link.download = `${name}-screenshot.png`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
      toast('Screenshot saved.');
    }, 'image/png');
  } catch (error) {
    console.error('Could not capture video screenshot:', error);
    toast('This video frame could not be captured.');
  }
}

function openSleepTimer() {
  $('#sleep-timer-duration').value = String(state.sleepTimerMinutes);
  $('#sleep-timer-dialog').showModal();
}

function setSleepTimer(minutes) {
  clearTimeout(state.sleepTimer);
  state.sleepTimer = 0;
  state.sleepTimerMinutes = minutes;
  state.sleepTimerEndsAt = 0;
  if (minutes) {
    state.sleepTimerEndsAt = Date.now() + minutes * 60 * 1000;
    state.sleepTimer = setTimeout(() => {
      state.sleepTimer = 0;
      state.sleepTimerMinutes = 0;
      state.sleepTimerEndsAt = 0;
      video.pause();
      saveVideoPosition(true);
      toast('Sleep timer ended. Playback paused.');
      updateSleepTimerLabel();
    }, minutes * 60 * 1000);
  }
  updateSleepTimerLabel();
  toast(minutes ? `Sleep timer set for ${minutes} minutes.` : 'Sleep timer turned off.');
}

function updateSleepTimerLabel() {
  const button = $('#sleep-timer-button');
  if (!state.sleepTimerEndsAt) {
    button.textContent = 'Sleep Timer';
    button.title = '';
    return;
  }
  const minutes = Math.max(1, Math.ceil((state.sleepTimerEndsAt - Date.now()) / 60000));
  button.textContent = `Sleep Timer · ${minutes} min`;
  button.title = `Playback will stop in about ${minutes} minutes`;
}

async function saveVideoPosition(force = false) {
  if (!state.currentVideoId || !Number.isFinite(video.currentTime)) return;
  const position = video.currentTime;
  if (!force && Math.abs(position - state.lastSavedPosition) < 2) return;
  state.lastSavedPosition = position;
  try {
    const positions = await readStore('stats', 'video-positions') ?? {};
    if (position > 1 && !video.ended) positions[state.currentVideoId] = position;
    else delete positions[state.currentVideoId];
    await writeStore('stats', 'video-positions', positions);
  } catch (error) {
    console.error('Could not save video position:', error);
  }
}

function recordRecent(id) {
  state.recent = [id, ...state.recent.filter(item => item !== id)].slice(0, 50);
  writeStore('settings', 'recent', state.recent)
    .catch(error => console.error('Could not save playback history:', error));
}

function recordVideoPlayback(id) {
  if (state.currentVideoId !== id) return;
  recordRecent(id);
  render();
}

async function playVideo(id, queue = null) {
  const item = itemById(id);
  if (!item || item.kind !== 'video') return;
  if (!item.url) {
    toast('Select this video file again to play it.');
    $('#media-input').click();
    return;
  }
  if (state.currentVideoId && state.currentVideoId !== id) await saveVideoPosition(true);
  if (queue) state.videoQueue = queue;
  else state.videoQueue = state.videos.map(entry => entry.id);
  if (state.currentAudioId) audio.pause();
  video.pause();
  state.currentVideoId = id;
  state.lastSavedPosition = 0;
  $('#video-name').textContent = item.title;
  hideVideoMessage();
  video.removeAttribute('src');
  video.load();
  video.src = item.url;
  video.playbackRate = state.videoSpeed;
  $('#video-player').showModal();
  document.body.classList.add('video-player-open');
  showVideoControls();
  updateVideoLayout();
  updatePlayerSettings();
  configureMediaSession();
  updateVideoProgress();
  render();
  try {
    await video.play();
    recordVideoPlayback(id);
  } catch (error) {
    if (error.name === 'AbortError') return;
    console.warn('Video playback could not start:', error);
    if (error.name === 'NotAllowedError') showVideoMessage('Press play to start this video.');
    else if (error.name === 'NotSupportedError' || video.error) showVideoMessage('This video format or codec is not supported by your browser.');
    else showVideoMessage('This video could not be played. Try selecting it again.');
  }
}

function playNextVideo() {
  const index = state.videoQueue.indexOf(state.currentVideoId);
  const nextId = state.videoQueue[index + 1];
  if (nextId) playVideo(nextId, state.videoQueue);
}

function playPreviousVideo() {
  if (video.currentTime > 3) {
    video.currentTime = 0;
    return;
  }
  const index = state.videoQueue.indexOf(state.currentVideoId);
  const previousId = state.videoQueue[index - 1];
  if (previousId) playVideo(previousId, state.videoQueue);
}

async function playAudio(id) {
  const item = itemById(id);
  if (!item || item.kind !== 'audio') return;
  if (!item.url) {
    toast('Select this audio file again to play it.');
    $('#media-input').click();
    return;
  }
  if (state.currentAudioId === id) {
    if (audio.paused) {
      try {
        await audio.play();
      } catch (error) {
        if (error.name === 'AbortError') return;
        console.error('Audio playback failed:', error);
        toast('This audio format is not supported by your browser.');
      }
    } else audio.pause();
    return;
  }
  if (state.currentVideoId && $('#video-player').open) video.pause();
  if (state.currentAudioId) audio.pause();
  state.currentAudioId = id;
  const playlist = state.playlists.find(entry => entry.id === state.playlistId);
  state.audioQueue = playlist?.songIds.length
    ? playlist.songIds.filter(itemId => itemById(itemId)?.kind === 'audio')
    : state.audios.map(entry => entry.id);
  audio.src = item.url;
  audio.volume = state.audioVolume;
  audio.muted = state.audioMuted;
  $('#audio-dock').hidden = false;
  try {
    await audio.play();
    recordRecent(id);
  } catch (error) {
    if (error.name === 'AbortError') return;
    console.error('Audio playback failed:', error);
    toast('This audio format is not supported by your browser.');
  }
  render();
}

async function relinkItem(file, kind) {
  const id = itemId(file, kind);
  const existing = itemById(id);
  if (existing?.url) return { item: existing, duplicate: true };

  const metadata = {
    ...(existing ?? {}),
    id, kind, fileName: file.name, type: file.type || 'application/octet-stream',
    size: file.size, lastModified: file.lastModified,
    title: existing?.title || titleFromName(file.name),
    artist: existing?.artist || 'Unknown artist',
    album: existing?.album || 'Unknown album',
    duration: existing?.duration ?? 0,
    added: existing?.added ?? Date.now()
  };
  await ensureStorageAvailable(file.size);
  await saveMedia(id, file, metadata, MEDIA_STORE_KEY);
  const item = { ...metadata, url: URL.createObjectURL(file), file };
  if (existing) {
    const index = state.items.indexOf(existing);
    if (index >= 0) state.items[index] = item;
    if (existing.url) URL.revokeObjectURL(existing.url);
    if (existing.artworkUrl) URL.revokeObjectURL(existing.artworkUrl);
    if (kind === 'video') state.videos[state.videos.indexOf(existing)] = item;
    else state.audios[state.audios.indexOf(existing)] = item;
  } else {
    state.items.unshift(item);
    if (kind === 'video') state.videos.unshift(item);
    else state.audios.unshift(item);
  }
  if (kind === 'audio') {
    try {
      const embedded = await readEmbeddedMetadata(file);
      if (state.items.includes(item)) {
        item.title = embedded.title || item.title;
        item.artist = embedded.artist || item.artist;
        item.album = embedded.album || item.album;
        item.artwork = embedded.artwork ?? item.artwork ?? null;
        item.artworkUrl = embedded.artworkUrl || (item.artwork ? URL.createObjectURL(item.artwork) : '');
        await persistLibrary();
      }
    } catch (error) {
      console.warn(`Could not read audio tags from ${file.name}:`, error);
    }
  }
  return item;
}

async function importFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  const unsupported = files.filter(file => !kindOf(file));
  let added = 0;
  let duplicates = 0;
  const failures = [];
  for (const file of files) {
    const kind = kindOf(file);
    if (!kind) continue;
    try {
      const result = await relinkItem(file, kind);
      if (result.duplicate) duplicates++;
      else added++;
    } catch (error) {
      console.error(`Could not save local media "${file.name}":`, error);
      failures.push(mediaSaveError(error, file.name));
    }
  }
  render();
  if (failures.length) toast(failures[0]);
  else if (unsupported.length) toast(`${added} file${added === 1 ? '' : 's'} saved. ${unsupported.length} unsupported file${unsupported.length === 1 ? '' : 's'} skipped.`);
  else if (added && duplicates) toast(`${added} local file${added === 1 ? '' : 's'} saved. ${duplicates} duplicate${duplicates === 1 ? '' : 's'} skipped.`);
  else if (added) toast(`${added} local file${added === 1 ? '' : 's'} saved on this device.`);
  else if (duplicates) toast('Those files are already saved in your library.');
}

function scannedMediaId(folderId, relativePath) {
  return `scan:${folderId}:${encodeURIComponent(relativePath.replace(/\\/g, '/'))}`;
}

async function saveScannedFile(file, folder, relativePath) {
  const kind = kindOf(file);
  if (!kind) return false;
  const id = scannedMediaId(folder.id, relativePath);
  const existing = itemById(id);
  const metadata = {
    ...(existing ?? {}),
    id,
    kind,
    fileName: file.name,
    type: file.type || 'application/octet-stream',
    size: file.size,
    lastModified: file.lastModified,
    relativePath,
    sourceFolderId: folder.id,
    folderName: folder.name,
    scanMissing: false,
    title: existing?.title || titleFromName(file.name),
    artist: existing?.artist || 'Unknown artist',
    album: existing?.album || 'Unknown album',
    duration: existing?.duration ?? 0,
    added: existing?.added ?? Date.now()
  };
  const unchanged = existing?.url && existing.size === file.size &&
    existing.lastModified === file.lastModified && !existing.scanMissing;
  if (!unchanged) {
    await ensureStorageAvailable(existing?.size === file.size ? 0 : file.size);
    await saveMedia(id, file, metadata, MEDIA_STORE_KEY);
  }

  let item = existing;
  if (!unchanged) {
    item = { ...metadata, url: URL.createObjectURL(file), file };
    if (existing) {
      const index = state.items.indexOf(existing);
      if (index >= 0) state.items[index] = item;
      if (kind === 'video') {
        const videoIndex = state.videos.indexOf(existing);
        if (videoIndex >= 0) state.videos[videoIndex] = item;
        else state.videos.unshift(item);
      } else {
        const audioIndex = state.audios.indexOf(existing);
        if (audioIndex >= 0) state.audios[audioIndex] = item;
        else state.audios.unshift(item);
      }
      if (existing.url && existing.id !== state.currentVideoId && existing.id !== state.currentAudioId) {
        URL.revokeObjectURL(existing.url);
      }
    } else {
      state.items.unshift(item);
      if (kind === 'video') state.videos.unshift(item);
      else state.audios.unshift(item);
    }
  } else if (existing) {
    Object.assign(existing, metadata);
  }

  if (kind === 'audio' && !unchanged) {
    try {
      const embedded = await readEmbeddedMetadata(file);
      item.title = embedded.title || item.title;
      item.artist = embedded.artist || item.artist;
      item.album = embedded.album || item.album;
      item.artwork = embedded.artwork ?? item.artwork ?? null;
      item.artworkUrl = embedded.artworkUrl || (item.artwork ? URL.createObjectURL(item.artwork) : '');
      await persistLibrary();
    } catch (error) {
      console.warn(`Could not read audio tags from ${file.name}:`, error);
    }
  } else if (existing?.scanMissing) {
    await persistLibrary();
  }
  return !unchanged;
}

async function walkMediaFolder(
  directory,
  prefix = '',
  files = [],
  failures = [],
  stats = { enumerated: 0, unsupported: 0 },
  progress = null
) {
  try {
    for await (const entry of directory.values()) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.kind === 'directory') {
        await walkMediaFolder(entry, relativePath, files, failures, stats, progress);
      } else if (entry.kind === 'file') {
        stats.enumerated++;
        try {
          const file = await entry.getFile();
          const kind = kindOf(file);
          console.debug(`[SONIQ scanner] Discovered "${relativePath}" (${kind || 'unsupported'}; ${file.type || 'unknown MIME'}).`);
          if (kind) {
            files.push({ file, relativePath });
            if (progress) progress[kind]++;
            console.debug(`[SONIQ scanner] Supported ${kind} file: "${relativePath}" (${file.type || 'unknown MIME'})`);
          } else {
            stats.unsupported++;
          }
        } catch (error) {
          failures.push({ path: relativePath, error });
          console.error(`[SONIQ scanner] Failed to read "${relativePath}":`, error);
        }
        if (progress && (stats.enumerated === 1 || stats.enumerated % 25 === 0 ||
            Date.now() - progress.updatedAt > 500)) {
          progress.updatedAt = Date.now();
          state.scanProgress = `Scanning "${progress.folderName}"… ${stats.enumerated} files checked; ${progress.audio} audio and ${progress.video} video found.`;
          render();
        }
      }
    }
  } catch (error) {
    failures.push({ path: prefix || directory.name || 'selected folder', error });
    console.error(`[SONIQ scanner] Failed to enumerate "${prefix || directory.name || 'selected folder'}":`, error);
  }
  return { files, failures, unsupported: stats.unsupported, enumerated: stats.enumerated };
}

async function rememberScannedFolders() {
  try {
    await writeStore('settings', 'scan-folders', state.scannedFolders);
  } catch (error) {
    console.error('Could not remember scanned folders:', error);
    toast('Folder access could not be remembered. You can scan the folder again next time.');
  }
}

async function scanFolder(folder, { requestPermission = true } = {}) {
  if (!folder.handle || folder.handle.kind !== 'directory' || typeof folder.handle.values !== 'function') {
    throw new Error(`"${folder.name || 'Selected folder'}" is not a readable directory handle.`);
  }
  console.info(`[SONIQ scanner] Checking read permission for "${folder.name}".`);
  if (typeof folder.handle.queryPermission !== 'function') {
    throw new Error(`This browser cannot verify read permission for "${folder.name}".`);
  }
  let permission;
  if (requestPermission && typeof folder.handle.requestPermission === 'function') {
    permission = await folder.handle.requestPermission({ mode: 'read' });
  } else {
    permission = await folder.handle.queryPermission({ mode: 'read' });
  }
  console.info(`[SONIQ scanner] Read permission for "${folder.name}": ${permission}.`);
  if (permission !== 'granted') return { needsPermission: true, report: createScanReport() };

  const progress = { folderName: folder.name, audio: 0, video: 0, updatedAt: 0 };
  state.scanProgress = `Scanning "${folder.name}"…`;
  render();
  const { files, failures, unsupported, enumerated } = await walkMediaFolder(folder.handle, '', [], [], undefined, progress);
  const report = createScanReport();
  report.unsupported = unsupported;
  console.info(`[SONIQ scanner] Enumerated ${enumerated} files in "${folder.name}"; ${files.length} supported media files found.`);
  state.scanProgress = `Found ${progress.audio} audio and ${progress.video} video files in "${folder.name}". Importing…`;
  render();
  for (const failure of failures) {
    recordScanFailure(report, kindOf({ name: failure.path }), failure.path, failure.error);
  }
  const seen = new Set();
  for (const [index, entry] of files.entries()) {
    const id = scannedMediaId(folder.id, entry.relativePath);
    const kind = kindOf(entry.file);
    report[kind].discovered++;
    state.scanProgress = `Saving ${index + 1} of ${files.length} supported files from "${folder.name}"…`;
    if (index === 0 || index % 10 === 0 || index === files.length - 1) render();
    try {
      const imported = await saveScannedFile(entry.file, folder, entry.relativePath);
      if (imported) {
        report[kind].imported++;
        console.info(`[SONIQ scanner] Imported ${kind} "${entry.relativePath}" with ID ${id}.`);
      } else {
        report[kind].skipped++;
        console.info(`[SONIQ scanner] Skipped unchanged ${kind} "${entry.relativePath}" with ID ${id}.`);
      }
      seen.add(id);
    } catch (error) {
      recordScanFailure(report, kind, entry.relativePath, error);
      console.error(`Could not save scanned file "${entry.relativePath}":`, error);
    }
  }

  if (!report.audio.failed && !report.video.failed && !report.scanErrors) {
    let changed = false;
    for (const item of state.items) {
      if (item.sourceFolderId === folder.id && !seen.has(item.id) && !item.scanMissing) {
        item.scanMissing = true;
        changed = true;
      }
    }
    if (changed) {
      try {
        await persistLibrary();
      } catch (error) {
        recordScanFailure(report, '', folder.name, error);
        console.error(`Could not save scan results for "${folder.name}":`, error);
      }
    }
  }
  console.info(`[SONIQ scanner] Completed "${folder.name}": ${formatScanReport(report)}.`);
  return { report, complete: !report.audio.failed && !report.video.failed && !report.scanErrors };
}

async function scanSelectedFolder() {
  if (state.scanBusy) return;
  if (typeof window.showDirectoryPicker !== 'function') {
    const folderInput = $('#folder-input');
    if (!('webkitdirectory' in folderInput)) {
      state.scanSummary = 'Folder scanning is not supported in this browser. Open files individually instead.';
      state.scanProgress = '';
      render();
      toast(state.scanSummary);
      return;
    }
    state.folderSelectionMode = 'scan';
    state.scanSummary = '';
    state.scanProgress = 'Choose a folder to scan its audio and video files.';
    render();
    try {
      folderInput.click();
    } catch (error) {
      state.folderSelectionMode = 'manual';
      state.scanProgress = '';
      state.scanSummary = `Could not open the folder picker: ${String(error?.message ?? 'Unknown error')}`;
      console.error('[SONIQ scanner] Could not open the fallback folder picker:', error);
      render();
      toast(state.scanSummary);
    }
    return;
  }

  state.scanBusy = true;
  state.scanSummary = '';
  state.scanProgress = 'Opening the folder picker…';
  render();
  let handle;
  try {
    console.info('[SONIQ scanner] Opening the native folder picker.');
    handle = await window.showDirectoryPicker({ mode: 'read' });
  } catch (error) {
    if (error?.name === 'AbortError') {
      state.scanSummary = 'Folder selection cancelled.';
    } else {
      state.scanSummary = `Could not open the folder picker: ${String(error?.message ?? 'Unknown error')}`;
      console.error('[SONIQ scanner] Could not open the folder picker:', error);
      toast(state.scanSummary);
    }
    state.scanBusy = false;
    state.scanProgress = '';
    render();
    return;
  }

  try {
    if (!handle || handle.kind !== 'directory' || typeof handle.values !== 'function') {
      throw new Error('The folder picker did not return a readable directory.');
    }
    console.info(`[SONIQ scanner] Folder selected: "${handle.name}".`);
    state.scanProgress = `Selected "${handle.name}". Checking folder permission…`;
    render();
    let permission = await handle.queryPermission({ mode: 'read' });
    if (permission !== 'granted' && typeof handle.requestPermission === 'function') {
      permission = await handle.requestPermission({ mode: 'read' });
    }
    if (permission !== 'granted') {
      throw new Error(`Read permission was not granted for "${handle.name}".`);
    }

    let folder = null;
    for (const saved of state.scannedFolders) {
      if (!saved.handle || typeof saved.handle.isSameEntry !== 'function') continue;
      try {
        if (await saved.handle.isSameEntry(handle)) {
          folder = saved;
          break;
        }
      } catch (error) {
        console.warn('[SONIQ scanner] Could not compare a saved folder handle:', error);
      }
    }
    if (!folder) {
      folder = { id: crypto.randomUUID(), name: handle.name, handle, mode: 'handle' };
      state.scannedFolders.push(folder);
    } else {
      folder.handle = handle;
      folder.name = handle.name;
    }
    await rememberScannedFolders();
    console.info(`[SONIQ scanner] Starting recursive scan of "${folder.name}".`);
    await rescanFolders([folder], true, false);
  } catch (error) {
    state.scanSummary = `Could not scan the selected folder: ${String(error?.message ?? 'Unknown error')}`;
    console.error('[SONIQ scanner] Folder scan failed:', error);
    toast(state.scanSummary);
  } finally {
    state.scanBusy = false;
    state.scanProgress = '';
    render();
  }
}

async function scanFallbackFolder(fileList) {
  const files = [...fileList];
  const report = createScanReport();
  const byRoot = new Map();
  const seenByFolder = new Map();
  state.scanProgress = `Scanning the selected folder… ${files.length} files selected.`;
  render();
  console.info(`[SONIQ scanner] Folder picker returned ${files.length} files.`);
  for (const [index, file] of files.entries()) {
    const path = file.webkitRelativePath || file.name;
    const parts = path.split('/');
    const rootName = parts.length > 1 ? parts.shift() : 'Selected folder';
    const relativePath = parts.join('/') || file.name;
    let folder = byRoot.get(rootName);
    if (!folder) {
      folder = state.scannedFolders.find(saved => saved.mode === 'fallback' && saved.name === rootName);
      if (!folder) {
        folder = { id: `fallback:${encodeURIComponent(rootName)}`, name: rootName, handle: null, mode: 'fallback' };
        state.scannedFolders.push(folder);
      }
      byRoot.set(rootName, folder);
      seenByFolder.set(folder.id, new Set());
    }
    const kind = kindOf(file);
    if (kind) report[kind].discovered++;
    state.scanProgress = `Scanning the selected folder… ${index + 1} of ${files.length} files checked; ${report.audio.discovered} audio and ${report.video.discovered} video found.`;
    if (index === 0 || index % 10 === 0 || index === files.length - 1) render();
    if (!kind) {
      report.unsupported++;
      continue;
    }
    console.debug(`[SONIQ scanner] Supported ${kind} file: "${path}" (${file.type || 'unknown MIME'})`);
    state.scanProgress = `Saving ${index + 1} of ${files.length} selected files… ${report.audio.discovered} audio and ${report.video.discovered} video found.`;
    if (index === 0 || index % 10 === 0 || index === files.length - 1) render();
    try {
      if (await saveScannedFile(file, folder, relativePath)) {
        report[kind].imported++;
        console.info(`[SONIQ scanner] Imported ${kind} "${path}".`);
      } else {
        report[kind].skipped++;
        console.info(`[SONIQ scanner] Skipped unchanged ${kind} "${path}".`);
      }
      seenByFolder.get(folder.id).add(scannedMediaId(folder.id, relativePath));
    } catch (error) {
      recordScanFailure(report, kind, path, error);
      console.error(`[SONIQ scanner] Could not save "${path}":`, error);
    }
  }
  console.info(`[SONIQ scanner] Folder selection contained ${files.length} files; ${report.audio.discovered + report.video.discovered} supported media files found.`);
  if (!report.audio.failed && !report.video.failed) {
    let changed = false;
    for (const item of state.items) {
      const seen = seenByFolder.get(item.sourceFolderId);
      if (seen && !seen.has(item.id) && !item.scanMissing) {
        item.scanMissing = true;
        changed = true;
      }
    }
    if (changed) {
      try {
        await persistLibrary();
      } catch (error) {
        recordScanFailure(report, '', 'Library metadata', error);
        console.error('Could not save folder scan results:', error);
      }
    }
  }
  await rememberScannedFolders();
  state.scanProgress = '';
  const found = report.audio.discovered + report.video.discovered;
  const note = found ? '' : 'No supported audio or video files were found in the selected folder.';
  state.scanSummary = formatScanReport(report, note);
  render();
  toast(state.scanSummary);
}

async function rescanFolders(folders = state.scannedFolders, alreadyBusy = false, requestPermission = true) {
  if (state.scanBusy && !alreadyBusy) return;
  if (!folders.length) {
    return scanSelectedFolder();
  }
  const handleFolders = folders.filter(folder => folder.handle);
  const fallbackFolders = folders.filter(folder => !folder.handle);
  if (!handleFolders.length && fallbackFolders.length) {
    state.scanSummary = 'Select the folder again to rescan it in this browser.';
    render();
    state.folderSelectionMode = 'scan';
    toast(state.scanSummary);
    $('#folder-input').click();
    return;
  }

  state.scanBusy = true;
  state.scanSummary = '';
  state.scanProgress = 'Checking folder permissions and scanning…';
  render();
  const report = createScanReport();
  let permissionNeeded = false;
  let incomplete = false;
  try {
    for (const folder of handleFolders) {
      state.scanProgress = `Preparing to scan "${folder.name}"…`;
      render();
      try {
        const result = await scanFolder(folder, { requestPermission });
        mergeScanReports(report, result.report);
        permissionNeeded = permissionNeeded || Boolean(result.needsPermission);
        incomplete = incomplete || !result.complete && !result.needsPermission;
      } catch (error) {
        incomplete = true;
        recordScanFailure(report, '', folder.name, error);
        console.error(`Could not scan folder "${folder.name}":`, error);
      }
    }
  } catch (error) {
    incomplete = true;
    recordScanFailure(report, '', 'Folder scan', error);
    console.error('[SONIQ scanner] Unexpected error during scan:', error);
  } finally {
    state.scanBusy = false;
    state.scanProgress = '';
    render();
  }
  const found = report.audio.discovered + report.video.discovered;
  const note = permissionNeeded
    ? 'Folder permission is needed; no files were scanned from that folder.'
    : incomplete
      ? 'Some files could not be scanned; existing saved files were kept.'
      : !found
        ? 'No supported audio or video files were found in this folder.'
        : '';
  state.scanSummary = formatScanReport(report, note);
  render();
  console.info(`[SONIQ scanner] Final scan report: ${state.scanSummary}`);
  toast(state.scanSummary);
}

async function restoreScannedFolders() {
  const saved = state.scannedFolders.filter(folder => folder.handle);
  if (!saved.length) return;
  if (typeof window.showDirectoryPicker !== 'function') {
    toast('Saved folder handles are unavailable in this browser. Use Scan Device Folders to select a folder again.');
    return;
  }
  const available = [];
  let permissionNeeded = false;
  for (const folder of saved) {
    try {
      const permission = await folder.handle.queryPermission({ mode: 'read' });
      if (permission === 'granted') available.push(folder);
      else permissionNeeded = true;
    } catch (error) {
      permissionNeeded = true;
      console.warn(`Could not restore access to folder "${folder.name}":`, error);
    }
  }
  if (available.length) await rescanFolders(available, false, false);
  if (permissionNeeded) {
    toast('Folder access needs your permission. Choose Rescan Folders to grant access again.');
  }
}

function openPlaylistDialog(id = '') {
  state.playlistEditId = id;
  $('#playlist-dialog-title').textContent = id ? 'Rename playlist' : 'New playlist';
  $('#playlist-name').value = id ? state.playlists.find(item => item.id === id)?.name ?? '' : '';
  $('#playlist-dialog').showModal();
  $('#playlist-name').focus();
}

function askConfirmation(title, message, action) {
  $('#confirm-title').textContent = title;
  $('#confirm-copy').textContent = message;
  confirmAction = action;
  $('#confirm-dialog').showModal();
}

async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await $('#video-stage').requestFullscreen();
  } catch (error) {
    console.error('Fullscreen could not be opened:', error);
    toast('Fullscreen is not available in this browser.');
  }
}

function closeVideo() {
  saveVideoPosition(true);
  if (!state.backgroundPlay) video.pause();
  $('#video-player').close();
  updateVideoBackgroundDock();
}

function returnToVideo() {
  if (!state.currentVideoId || $('#video-player').open) return;
  $('#video-player').showModal();
  showVideoControls();
  updateVideoLayout();
  updatePlayerSettings();
  updateVideoProgress();
}

function stopBackgroundVideo() {
  state.backgroundPlay = false;
  video.pause();
  setVideoSetting('video-background-play', false);
  configureMediaSession();
  if ($('#video-player').open) $('#video-player').close();
  updatePlayerSettings();
  render();
}

function togglePlayerOptions() {
  const options = $('#video-options');
  const expanded = $('#video-options-toggle').getAttribute('aria-expanded') === 'true';
  options.hidden = expanded;
  $('#video-options-toggle').setAttribute('aria-expanded', String(!expanded));
  $('#video-options-toggle').setAttribute('aria-label', expanded ? 'Show player options' : 'Hide player options');
  showVideoControls();
}

function bindEvents() {
  const player = $('#video-player');
  document.addEventListener('pointermove', () => {
    if (player.open) showVideoControls();
  });
  document.addEventListener('pointerdown', event => {
    if (!player.open) return;
    if (event.target instanceof Element && event.target.closest('#video-seek')) {
      videoSeekPointerId = event.pointerId;
    }
    showVideoControls();
  });
  document.addEventListener('pointercancel', event => {
    if (videoSeekPointerId === event.pointerId) {
      videoSeekPointerId = null;
      showVideoControls();
    }
  });
  document.addEventListener('focusin', () => {
    if (player.open) showVideoControls();
  });
  document.addEventListener('focusout', () => {
    if (player.open) showVideoControls();
  });
  if (!window.PointerEvent) {
    document.addEventListener('touchstart', () => {
      if (player.open) showVideoControls();
    }, { passive: true });
  }
  document.addEventListener('pointerup', event => {
    if (videoSeekPointerId === event.pointerId) {
      videoSeekPointerId = null;
      showVideoControls();
    }
  });

  document.addEventListener('click', event => {
    if (player.open) showVideoControls();
    const nav = event.target.closest('[data-view]');
    if (nav) {
      state.view = nav.dataset.view;
      render();
      return;
    }

    const action = event.target.closest('[data-action]');
    if (action) {
      const { action: name, id } = action.dataset;
      if (name === 'open-files') $('#media-input').click();
      if (name === 'scan-folders') scanSelectedFolder();
      if (name === 'rescan-folders') rescanFolders();
      if (name === 'delete-media') {
        const item = itemById(id);
        if (item) askConfirmation(
          'Delete this local file?',
          `"${item.fileName}" and its saved copy will be removed from this device.`,
          () => removeMediaItem(id)
        );
      }
      if (name === 'new-playlist') openPlaylistDialog();
      if (name === 'rename-playlist' && state.playlistId) openPlaylistDialog(state.playlistId);
      if (name === 'delete-playlist' && state.playlistId) {
        askConfirmation('Delete this playlist?', 'Your audio files and library will not be affected.', () => {
          state.playlists = state.playlists.filter(list => list.id !== state.playlistId);
          state.playlistId = '';
          savePlaylists();
          render();
        });
      }
      if (name === 'favorite') toggleFavorite(id);
      if (name === 'add-to-playlist') addAudioToPlaylist(id);
      if (name === 'remove-from-playlist') removeAudioFromPlaylist(id);
      return;
    }

    const videoCard = event.target.closest('[data-open-video]');
    if (videoCard) {
      const videos = filteredItems('video').map(item => item.id);
      playVideo(videoCard.dataset.openVideo, videos);
      return;
    }
    const audioButton = event.target.closest('[data-play-audio]');
    if (audioButton) playAudio(audioButton.dataset.playAudio);

    if (event.target.closest('#open-files')) $('#media-input').click();
    if (event.target.closest('#audio-play')) {
      if (audio.paused && state.currentAudioId) playAudio(state.currentAudioId);
      else audio.pause();
    }
    if (event.target.closest('#audio-next')) playNextAudio();
    if (event.target.closest('#audio-previous')) playPreviousAudio();
    if (event.target.closest('#audio-mute')) {
      state.audioMuted = !state.audioMuted;
      audio.muted = state.audioMuted;
      $('#audio-mute').textContent = state.audioMuted ? '◌' : '◖';
    }
    if (event.target.closest('#video-close')) closeVideo();
    if (event.target.closest('#video-play')) toggleVideoPlay();
    if (event.target.closest('#video-next')) playNextVideo();
    if (event.target.closest('#video-previous')) playPreviousVideo();
    if (event.target.closest('#fullscreen-button')) toggleFullscreen();
    if (event.target.closest('#fullscreen-exit')) toggleFullscreen();
    if (event.target.closest('#video-options-toggle')) togglePlayerOptions();
    if (event.target.closest('#night-mode-button')) toggleNightMode();
    if (event.target.closest('#customise-items-button')) openCustomiseItems();
    if (event.target.closest('#sleep-timer-button')) openSleepTimer();
    if (event.target.closest('#screenshot-button')) captureVideoScreenshot();
    if (event.target.closest('#background-play-button')) toggleBackgroundPlay();
    if (event.target.closest('#rotation-button')) rotateVideo(90);
    if (event.target.closest('#lock-screen-button')) toggleLockScreenControls();
    if (event.target.closest('#video-background-return')) returnToVideo();
    if (event.target.closest('#video-background-stop')) stopBackgroundVideo();
  });

  $('#media-input').addEventListener('change', event => {
    importFiles(event.target.files);
    event.target.value = '';
  });
  $('#folder-input').addEventListener('change', async event => {
    const files = [...event.target.files];
    event.target.value = '';
    if (state.folderSelectionMode !== 'scan') {
      importFiles(files);
      return;
    }

    state.scanBusy = true;
    state.scanSummary = '';
    state.scanProgress = files.length
      ? `Scanning ${files.length} selected files…`
      : 'Checking the selected folder…';
    render();
    try {
      await scanFallbackFolder(files);
    } catch (error) {
      state.scanSummary = `Could not scan the selected folder: ${String(error?.message ?? 'Unknown error')}`;
      console.error('[SONIQ scanner] Folder scan failed:', error);
      toast(state.scanSummary);
    } finally {
      state.folderSelectionMode = 'manual';
      state.scanBusy = false;
      state.scanProgress = '';
      render();
    }
  });
  $('#folder-input').addEventListener('cancel', () => {
    if (state.folderSelectionMode !== 'scan') return;
    state.folderSelectionMode = 'manual';
    state.scanBusy = false;
    state.scanProgress = '';
    state.scanSummary = 'Folder picker closed without returning new files.';
    render();
  });
  $('#search').addEventListener('input', event => {
    state.search = event.target.value.trim();
    render();
  });
  $('#main-content').addEventListener('keydown', event => {
    if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('[data-open-video]')) {
      event.preventDefault();
      const videos = filteredItems('video').map(item => item.id);
      playVideo(event.target.dataset.openVideo, videos);
    }
  });
  $('#main-content').addEventListener('change', event => {
    if (event.target.id === 'playlist-select') {
      state.playlistId = event.target.value;
      render();
    }
  });
  $('#playlist-form').addEventListener('submit', event => {
    event.preventDefault();
    const name = $('#playlist-name').value.trim();
    if (!name) return;
    if (state.playlistEditId) {
      const list = state.playlists.find(item => item.id === state.playlistEditId);
      if (list) list.name = name;
    } else {
      state.playlists.push({ id: crypto.randomUUID(), name, songIds: [] });
    }
    savePlaylists();
    $('#playlist-dialog').close();
    render();
  });
  $('#playlist-cancel').addEventListener('click', () => $('#playlist-dialog').close());
  $('#confirm-cancel').addEventListener('click', () => {
    confirmAction = null;
    $('#confirm-dialog').close();
  });
  $('#confirm-accept').addEventListener('click', () => {
    const action = confirmAction;
    confirmAction = null;
    $('#confirm-dialog').close();
    action?.();
  });

  $('#customise-form').addEventListener('submit', event => {
    event.preventDefault();
    state.visibleVideoOptions = $$('input[name="video-option"]:checked', $('#customise-items-list'))
      .map(input => input.value);
    setVideoSetting('video-visible-options', state.visibleVideoOptions);
    updatePlayerSettings();
    $('#customise-dialog').close();
    toast('Player options updated.');
  });
  $('#customise-cancel').addEventListener('click', () => $('#customise-dialog').close());
  $('#sleep-timer-form').addEventListener('submit', event => {
    event.preventDefault();
    setSleepTimer(Number($('#sleep-timer-duration').value));
    $('#sleep-timer-dialog').close();
  });
  $('#sleep-timer-cancel').addEventListener('click', () => $('#sleep-timer-dialog').close());
  $('#customise-dialog').addEventListener('close', showVideoControls);
  $('#sleep-timer-dialog').addEventListener('close', showVideoControls);

  video.addEventListener('play', () => {
    hideVideoMessage();
    $('#video-play').textContent = 'Ⅱ';
    $('#video-play').setAttribute('aria-label', 'Pause');
    configureMediaSession();
    showVideoControls();
  });
  video.addEventListener('pause', () => {
    $('#video-play').textContent = '▶';
    $('#video-play').setAttribute('aria-label', 'Play');
    configureMediaSession();
    showVideoControls();
  });
  video.addEventListener('loadedmetadata', async () => {
    hideVideoMessage();
    const item = itemById(state.currentVideoId);
    if (item && Number.isFinite(video.duration)) {
      item.duration = video.duration;
      persistLibrary().catch(error => console.error('Could not save video duration:', error));
      render();
    }
    try {
      const positions = await readStore('stats', 'video-positions') ?? {};
      const position = positions[state.currentVideoId];
      if (Number.isFinite(position) && position > 1 && position < video.duration - 1) video.currentTime = position;
    } catch (error) {
      console.error('Could not restore video position:', error);
    }
    updateVideoProgress();
  });
  video.addEventListener('timeupdate', () => {
    updateVideoProgress();
    saveVideoPosition();
  });
  video.addEventListener('ended', () => {
    saveVideoPosition(true);
    playNextVideo();
  });
  video.addEventListener('error', () => {
    const item = itemById(state.currentVideoId);
    if (video.error && item?.url && video.currentSrc === item.url) {
      console.warn(`Video error ${video.error.code}: ${video.error.message}`);
      showVideoMessage('This video format or codec is not supported by your browser.');
    }
  });
  $('#video-seek').addEventListener('input', event => {
    state.userSeeking = true;
    if (video.duration) video.currentTime = Number(event.target.value) / 1000 * video.duration;
    state.userSeeking = false;
  });
  $('#video-speed').addEventListener('change', event => {
    state.videoSpeed = Number(event.target.value);
    video.playbackRate = state.videoSpeed;
    setVideoSetting('video-playback-speed', state.videoSpeed);
  });
  $('#audio-seek').addEventListener('input', event => {
    state.userSeeking = true;
    if (audio.duration) audio.currentTime = Number(event.target.value) / 1000 * audio.duration;
  });
  $('#audio-seek').addEventListener('change', () => { state.userSeeking = false; });
  $('#audio-volume').addEventListener('input', event => {
    state.audioVolume = Number(event.target.value);
    audio.volume = state.audioVolume;
    state.audioMuted = false;
    audio.muted = false;
    rememberAudioVolume();
  });
  audio.addEventListener('timeupdate', updateAudioProgress);
  audio.addEventListener('loadedmetadata', () => {
    const item = itemById(state.currentAudioId);
    if (item && Number.isFinite(audio.duration)) {
      item.duration = audio.duration;
      persistLibrary().catch(error => console.error('Could not save audio duration:', error));
    }
    updateAudioProgress();
    render();
  });
  audio.addEventListener('play', () => {
    $('#audio-play').textContent = 'Ⅱ';
    $('#audio-play').setAttribute('aria-label', 'Pause audio');
    render();
  });
  audio.addEventListener('pause', () => {
    $('#audio-play').textContent = '▶';
    $('#audio-play').setAttribute('aria-label', 'Play audio');
    render();
  });
  audio.addEventListener('ended', playNextAudio);
  audio.addEventListener('error', () => {
    if (audio.error) toast('This audio format or codec is not supported by your browser.');
  });

  player.addEventListener('click', event => {
    if (event.target === $('#video-player')) closeVideo();
  });
  player.addEventListener('close', () => {
    clearTimeout(videoControlsHideTimer);
    videoControlsHideTimer = 0;
    videoSeekPointerId = null;
    player.classList.remove('controls-hidden');
    document.body.classList.remove('video-player-open');
    saveVideoPosition(true);
    if (!state.backgroundPlay && !video.paused) video.pause();
    if (document.fullscreenElement === $('#video-stage')) {
      document.exitFullscreen().catch(error => console.warn('Could not exit video fullscreen:', error));
    }
    updateVideoBackgroundDock();
  });
  document.addEventListener('fullscreenchange', () => {
    const fullscreen = document.fullscreenElement === $('#video-stage');
    $('#fullscreen-button').setAttribute('aria-label', fullscreen ? 'Exit fullscreen' : 'Enter fullscreen');
    updateVideoLayout();
  });
  $('#install-button').addEventListener('click', installApp);
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    deferredInstall = event;
    $('#install-button').hidden = false;
  });
  document.addEventListener('keydown', handleKeyboard);
  window.addEventListener('resize', updateVideoLayout);
  window.addEventListener('pagehide', () => saveVideoPosition(true));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveVideoPosition(true);
  });
}

function toggleVideoPlay() {
  if (!video.paused) {
    video.pause();
    return;
  }
  const id = state.currentVideoId;
  video.play()
    .then(() => recordVideoPlayback(id))
    .catch(error => {
      if (error.name === 'AbortError') return;
      console.warn('Video playback could not start:', error);
      showVideoMessage('Press play to start this video.');
    });
}

function seekVideo(delta) {
  if (Number.isFinite(video.duration)) video.currentTime = Math.max(0, Math.min(video.duration, video.currentTime + delta));
}

function playNextAudio() {
  const index = state.audioQueue.indexOf(state.currentAudioId);
  if (index >= 0 && state.audioQueue[index + 1]) playAudio(state.audioQueue[index + 1]);
}

function playPreviousAudio() {
  if (audio.currentTime > 3) {
    audio.currentTime = 0;
    return;
  }
  const index = state.audioQueue.indexOf(state.currentAudioId);
  if (index > 0) playAudio(state.audioQueue[index - 1]);
}

function toggleFavorite(id) {
  if (state.favorites.has(id)) state.favorites.delete(id);
  else state.favorites.add(id);
  writeStore('settings', 'favorites', [...state.favorites])
    .catch(error => console.error('Could not save audio favorites:', error));
  render();
}

function addAudioToPlaylist(id) {
  if (!state.playlists.length) {
    toast('Create an audio playlist first.');
    return;
  }
  if (!state.playlistId) state.playlistId = state.playlists[0].id;
  const playlist = state.playlists.find(item => item.id === state.playlistId);
  if (!playlist) return;
  if (!playlist.songIds.includes(id)) {
    playlist.songIds.push(id);
    savePlaylists();
    toast(`Added to ${playlist.name}`);
  } else toast('This track is already in the playlist.');
  render();
}

function removeAudioFromPlaylist(id) {
  const playlist = state.playlists.find(item => item.id === state.playlistId);
  if (!playlist) return;
  playlist.songIds = playlist.songIds.filter(itemId => itemId !== id);
  savePlaylists();
  render();
}

function savePlaylists() {
  writeStore('playlists', 'all', state.playlists)
    .catch(error => console.error('Could not save playlists:', error));
}

function handleKeyboard(event) {
  if ($('#video-player').open) showVideoControls();
  if (!$('#video-player').open || ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName) ||
      $('#customise-dialog').open || $('#sleep-timer-dialog').open) return;
  if (event.code === 'Space') {
    event.preventDefault();
    toggleVideoPlay();
  } else if (event.key === 'ArrowLeft') seekVideo(-10);
  else if (event.key === 'ArrowRight') seekVideo(10);
  else if (event.key.toLowerCase() === 'f') toggleFullscreen();
}

async function installApp() {
  if (!deferredInstall) {
    toast('Use your browser menu to install SONIQ or add it to your home screen.');
    return;
  }
  try {
    await deferredInstall.prompt();
    await deferredInstall.userChoice;
  } catch (error) {
    console.warn('Install prompt was dismissed or unavailable:', error);
  }
  deferredInstall = null;
  $('#install-button').hidden = true;
}

async function init() {
  await requestPersistentStorage();
  try {
    const [
      library, savedMedia, playlists, recent, favorites, volume, scannedFolders,
      videoSpeed, visibleVideoOptions, nightMode, lockScreenControls, backgroundPlay
    ] = await Promise.all([
      readStore('library', MEDIA_STORE_KEY),
      readAllMedia(),
      readStore('playlists', 'all'),
      readStore('settings', 'recent'),
      readStore('settings', 'favorites'),
      readStore('settings', 'audio-volume'),
      readStore('settings', 'scan-folders'),
      readStore('settings', 'video-playback-speed'),
      readStore('settings', 'video-visible-options'),
      readStore('settings', 'video-night-mode'),
      readStore('settings', 'video-lock-screen-controls'),
      readStore('settings', 'video-background-play')
    ]);
    const mediaById = new Map((savedMedia ?? []).map(entry => [
      entry.id,
      entry.blob instanceof Blob ? entry.blob : entry instanceof Blob ? entry : null
    ]));
    state.items = (library ?? []).map(metadata => {
      const blob = mediaById.get(metadata.id);
      return {
        ...metadata,
        url: blob ? URL.createObjectURL(blob) : '',
        artworkUrl: metadata.artwork instanceof Blob ? URL.createObjectURL(metadata.artwork) : '',
        file: null
      };
    });
    state.videos = state.items.filter(item => item.kind === 'video');
    state.audios = state.items.filter(item => item.kind === 'audio');
    state.playlists = playlists ?? [];
    state.recent = recent ?? [];
    state.favorites = new Set(favorites ?? []);
    state.scannedFolders = Array.isArray(scannedFolders) ? scannedFolders : [];
    state.audioVolume = Number.isFinite(volume) ? volume : .8;
    state.videoSpeed = [0.5, 0.75, 1, 1.25, 1.5, 2].includes(videoSpeed) ? videoSpeed : 1;
    state.visibleVideoOptions = Array.isArray(visibleVideoOptions)
      ? visibleVideoOptions.filter(id => VIDEO_OPTIONS.some(option => option.id === id))
      : VIDEO_OPTIONS.map(option => option.id);
    state.nightMode = Boolean(nightMode);
    state.lockScreenControls = Boolean(lockScreenControls);
    state.backgroundPlay = Boolean(backgroundPlay);
    audio.volume = state.audioVolume;
    $('#audio-volume').value = state.audioVolume;
  } catch (error) {
    console.error('Could not load SONIQ library:', error);
    toast('Local library details could not be loaded. You can still open media files.');
  }
  bindEvents();
  render();
  updatePlayerSettings();
  configureMediaSession();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    const hadController = Boolean(navigator.serviceWorker.controller);
    if (hadController) {
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!navigator.serviceWorker.controller) return;
        if (video.paused && audio.paused && !state.scanBusy) {
          location.reload();
        } else {
          toast('A SONIQ update is ready. Refresh after playback or scanning finishes.');
        }
      }, { once: true });
    }
    navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' })
      .then(registration => registration.update())
      .catch(error => console.error('Offline app shell could not be enabled:', error));
  }
  await restoreScannedFolders();
}

init();
