import { deleteMedia, readAllMedia, readStore, saveMedia, writeStore } from './db.js';
import { readEmbeddedMetadata } from './metadata.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const video = $('#video-element');
const audio = $('#audio-element');
const MEDIA_STORE_KEY = 'items';
const AUDIO_EXTENSIONS = /\.(mp3|wav|flac|aac|m4a|ogg|opus|oga)$/i;
const VIDEO_EXTENSIONS = /\.(mp4|webm|mov|mkv|avi|m4v|3gp|ogv|mpg|mpeg|m2v)$/i;

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
  videoVolume: 1,
  videoMuted: false,
  audioVolume: 0.8,
  audioMuted: false,
  userSeeking: false,
  lastSavedPosition: 0,
  controlsTimer: 0,
  playlistEditId: ''
};

let deferredInstall = null;
let confirmAction = null;
let toastTimer = 0;

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
  if (file.type.startsWith('video/') || VIDEO_EXTENSIONS.test(file.name)) return 'video';
  if (file.type.startsWith('audio/') || AUDIO_EXTENSIONS.test(file.name)) return 'audio';
  return '';
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
  return `<article class="video-card" tabindex="0" role="button" data-open-video="${escapeHtml(item.id)}" aria-label="Play ${escapeHtml(item.title)}">
    <div class="video-thumb"><span class="thumb-symbol" aria-hidden="true">▶</span>${item.duration ? `<span class="duration-badge">${formatTime(item.duration)}</span>` : ''}</div>
    <div class="video-card-copy"><div><h3>${escapeHtml(item.title)}</h3><p>${needsRelink ? 'Select this file to restore playback' : 'Video'}</p></div><button class="icon-button media-delete" data-action="delete-media" data-id="${escapeHtml(item.id)}" aria-label="Delete ${escapeHtml(item.title)} from library" title="Delete from library">×</button></div>
  </article>`;
}

function videoGrid(items, title, copy) {
  if (!items.length) return emptyState(title, copy);
  return `<div class="video-grid">${items.map(videoCard).join('')}</div>`;
}

function audioChip(item) {
  return `<button class="audio-chip" data-play-audio="${escapeHtml(item.id)}" aria-label="Play ${escapeHtml(item.title)}">
    <span class="audio-chip-icon" aria-hidden="true">♫</span>
    <span class="audio-chip-copy"><b>${escapeHtml(item.title)}</b><small>${escapeHtml(item.artist || 'Unknown artist')}</small></span>
  </button>`;
}

function renderVideos() {
  const videos = filteredItems('video');
  const recentVideos = state.recent.map(itemById).filter(item => item?.kind === 'video').slice(0, 4);
  const unlinked = state.videos.some(item => !item.url);
  return `<div class="welcome"><div><p class="overline">SONIQ · LOCAL VIDEO PLAYER</p><h1>Your videos</h1><p>All your videos, ready when you are. Your files stay on this device.</p></div><button class="open-secondary" data-action="open-folder">Choose a folder</button></div>
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
    <span class="audio-row-title"><b>${escapeHtml(item.title)}</b><small>${escapeHtml(item.artist || 'Unknown artist')}</small></span>
    <span class="audio-meta">${escapeHtml(item.album || '')}</span><span class="audio-duration">${formatTime(item.duration)}</span>
    <button class="icon-button" data-action="favorite" data-id="${escapeHtml(item.id)}" aria-label="Favorite ${escapeHtml(item.title)}">${state.favorites.has(item.id) ? '♥' : '♡'}</button>
    ${selectedPlaylist
      ? `<button class="icon-button" data-action="remove-from-playlist" data-id="${escapeHtml(item.id)}" aria-label="Remove ${escapeHtml(item.title)} from playlist">−</button>`
      : `<button class="icon-button" data-action="add-to-playlist" data-id="${escapeHtml(item.id)}" aria-label="Add ${escapeHtml(item.title)} to playlist">＋</button>`}
    <button class="icon-button media-delete" data-action="delete-media" data-id="${escapeHtml(item.id)}" aria-label="Delete ${escapeHtml(item.title)} from library" title="Delete from library">×</button>
  </div>`).join('');
  return `<div class="page-heading"><div><p class="overline">SECONDARY PLAYER</p><h1>Audio</h1><p>Local tracks and your playlists.</p></div><div class="audio-page-controls">${addButton()}</div></div>
    ${playlistTools()}
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
  renderAudioDock();
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
  $('#video-duration').textContent = formatTime(duration);
  if (!state.userSeeking) $('#video-seek').value = duration ? current / duration * 1000 : 0;
  $('#video-play').textContent = video.paused ? '▶' : 'Ⅱ';
  $('#video-play').setAttribute('aria-label', video.paused ? 'Play' : 'Pause');
}

function showVideoMessage(message) {
  const element = $('#video-message');
  element.textContent = message;
  element.hidden = false;
}

function hideVideoMessage() {
  $('#video-message').hidden = true;
}

function scheduleControlHide() {
  clearTimeout(state.controlsTimer);
  if (video.paused || !$('#video-player').open) return;
  state.controlsTimer = setTimeout(() => {
    $('#video-controls').classList.add('controls-hidden');
    $('#video-stage').classList.add('cursor-hidden');
  }, 3200);
}

function revealVideoControls() {
  $('#video-controls').classList.remove('controls-hidden');
  $('#video-stage').classList.remove('cursor-hidden');
  scheduleControlHide();
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
  if (state.currentVideoId && $('#video-player').open) await saveVideoPosition(true);
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
  video.playbackRate = Number($('#video-speed').value);
  video.volume = state.videoVolume;
  video.muted = state.videoMuted;
  $('#video-player').showModal();
  revealVideoControls();
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

async function requestPictureInPicture() {
  if (!document.pictureInPictureEnabled || !video.requestPictureInPicture) {
    toast('Picture in Picture is not supported by this browser.');
    return;
  }
  try {
    if (document.pictureInPictureElement) await document.exitPictureInPicture();
    else await video.requestPictureInPicture();
  } catch (error) {
    console.error('Picture in Picture could not be opened:', error);
    toast('Picture in Picture is not available for this video.');
  }
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
  clearTimeout(state.controlsTimer);
  saveVideoPosition(true);
  video.pause();
  $('#video-player').close();
}

function bindEvents() {
  document.addEventListener('click', event => {
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
      if (name === 'open-folder') $('#folder-input').click();
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
    if (event.target.closest('#video-back')) seekVideo(-10);
    if (event.target.closest('#video-forward')) seekVideo(10);
    if (event.target.closest('#video-next')) playNextVideo();
    if (event.target.closest('#video-previous')) playPreviousVideo();
    if (event.target.closest('#video-mute')) toggleVideoMute();
    if (event.target.closest('#fullscreen-button')) toggleFullscreen();
    if (event.target.closest('#pip-button')) requestPictureInPicture();
  });

  $('#media-input').addEventListener('change', event => {
    importFiles(event.target.files);
    event.target.value = '';
  });
  $('#folder-input').addEventListener('change', event => {
    importFiles(event.target.files);
    event.target.value = '';
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

  $('#video-stage').addEventListener('pointermove', revealVideoControls);
  $('#video-stage').addEventListener('pointerdown', revealVideoControls);
  video.addEventListener('click', toggleVideoPlay);
  video.addEventListener('play', () => {
    hideVideoMessage();
    $('#video-play').textContent = 'Ⅱ';
    $('#video-play').setAttribute('aria-label', 'Pause');
    scheduleControlHide();
  });
  video.addEventListener('pause', () => {
    $('#video-play').textContent = '▶';
    $('#video-play').setAttribute('aria-label', 'Play');
    revealVideoControls();
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
  $('#video-speed').addEventListener('change', event => { video.playbackRate = Number(event.target.value); });
  $('#video-volume').addEventListener('input', event => {
    state.videoVolume = Number(event.target.value);
    video.volume = state.videoVolume;
    state.videoMuted = false;
    video.muted = false;
    $('#video-mute').textContent = state.videoVolume === 0 ? '◌' : '◖';
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

  $('#video-player').addEventListener('click', event => {
    if (event.target === $('#video-player')) closeVideo();
  });
  $('#video-player').addEventListener('close', () => {
    saveVideoPosition(true);
    if (!video.paused) video.pause();
    if (document.pictureInPictureElement) {
      document.exitPictureInPicture().catch(error => console.warn('Could not exit Picture in Picture:', error));
    }
  });
  $('#install-button').addEventListener('click', installApp);
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    deferredInstall = event;
    $('#install-button').hidden = false;
  });
  document.addEventListener('keydown', handleKeyboard);
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

function toggleVideoMute() {
  state.videoMuted = !state.videoMuted;
  video.muted = state.videoMuted;
  $('#video-mute').textContent = state.videoMuted ? '◌' : '◖';
  $('#video-mute').setAttribute('aria-label', state.videoMuted ? 'Unmute video' : 'Mute video');
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
  if (!$('#video-player').open || ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;
  if (event.code === 'Space') {
    event.preventDefault();
    toggleVideoPlay();
  } else if (event.key === 'ArrowLeft') seekVideo(-10);
  else if (event.key === 'ArrowRight') seekVideo(10);
  else if (event.key === 'ArrowUp') {
    event.preventDefault();
    video.volume = Math.min(1, video.volume + .05);
    state.videoVolume = video.volume;
    $('#video-volume').value = state.videoVolume;
  } else if (event.key === 'ArrowDown') {
    event.preventDefault();
    video.volume = Math.max(0, video.volume - .05);
    state.videoVolume = video.volume;
    $('#video-volume').value = state.videoVolume;
  } else if (event.key.toLowerCase() === 'm') toggleVideoMute();
  else if (event.key.toLowerCase() === 'f') toggleFullscreen();
  else if (event.key.toLowerCase() === 'p') requestPictureInPicture();
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
    const [library, savedMedia, playlists, recent, favorites, volume] = await Promise.all([
      readStore('library', MEDIA_STORE_KEY),
      readAllMedia(),
      readStore('playlists', 'all'),
      readStore('settings', 'recent'),
      readStore('settings', 'favorites'),
      readStore('settings', 'audio-volume')
    ]);
    const mediaById = new Map(savedMedia.map(entry => [
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
    state.audioVolume = Number.isFinite(volume) ? volume : .8;
    audio.volume = state.audioVolume;
    $('#audio-volume').value = state.audioVolume;
  } catch (error) {
    console.error('Could not load SONIQ library:', error);
    toast('Local library details could not be loaded. You can still open media files.');
  }
  bindEvents();
  render();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('./sw.js')
      .catch(error => console.error('Offline app shell could not be enabled:', error));
  }
}

init();
