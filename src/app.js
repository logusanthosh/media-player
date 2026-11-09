import { readStore, writeStore } from './db.js';
import { AudioEngine } from './audio.js';
import { readEmbeddedMetadata } from './metadata.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const audio = $('#audio');
const state = {
  songs: [], queue: [], currentId: null, view: 'home', search: '',
  favorites: new Set(), recent: [], playlists: [], playlistId: null,
  shuffle: false, repeat: 'off', sort: 'recent', isDragging: false,
  settings: { volume: 0.8, speed: 1, preset: 'Normal', bass: false, treble: false },
  customPresets: {},
  history: ['home'], historyIndex: 0
};
const engine = new AudioEngine(audio);
let playlistEditId = null;
let deferredInstall = null;
let toastTimer;
let dragSongId = null;
let pendingConfirmation = null;
const artColors = [['#9674bf','#353052'],['#da827f','#45304f'],['#76a99b','#2a3943'],['#d29d68','#493e59'],['#7190c9','#35334e'],['#d27eae','#49324d']];

function toast(message) {
  $('.toast')?.remove();
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = message;
  document.body.append(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), 3000);
}
function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
}
function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return '0:00';
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}
function currentSong() { return state.songs.find(song => song.id === state.currentId) ?? null; }
function artStyle(id = '1') {
  const colors = artColors[(Number.parseInt(id.slice(-2), 36) || 0) % artColors.length];
  return `background:radial-gradient(circle at 72% 25%,${colors[0]},transparent 35%),linear-gradient(145deg,${colors[1]},#161720)`;
}
function coverStyle(song) {
  return song?.artworkUrl ? `background-image:url(${song.artworkUrl});background-size:cover;background-position:center` : artStyle(song?.id);
}
function visibleSongs() {
  let songs = [...state.songs];
  if (state.search) {
    const term = state.search.toLocaleLowerCase();
    songs = songs.filter(song => `${song.title} ${song.artist} ${song.album}`.toLocaleLowerCase().includes(term));
  }
  if (state.view === 'favorites') songs = songs.filter(song => state.favorites.has(song.id));
  if (state.view === 'recent') songs = state.recent.map(id => state.songs.find(song => song.id === id)).filter(Boolean);
  if (state.view === 'playlist' && state.playlistId) {
    const playlist = state.playlists.find(item => item.id === state.playlistId);
    songs = (playlist?.songIds ?? []).map(id => state.songs.find(song => song.id === id)).filter(Boolean);
  }
  if (state.view === 'library' || state.view === 'home') {
    songs.sort((a,b) => state.sort === 'title' ? a.title.localeCompare(b.title) : state.sort === 'artist' ? a.artist.localeCompare(b.artist) : b.added - a.added);
  }
  return songs;
}

function renderTrackTable(songs, options = {}) {
  if (!songs.length) return `<div class="empty-state"><div class="empty-symbol">${options.symbol ?? '♫'}</div><h3>${escapeHtml(options.title ?? 'No songs here yet')}</h3><p>${escapeHtml(options.copy ?? 'Add music from your device to make this space yours.')}</p>${options.action === false ? '' : '<button class="primary-btn" data-action="import">＋ Add music</button>'}</div>`;
  const rows = songs.map(song => `<tr data-id="${escapeHtml(song.id)}" ${state.view === 'playlist' ? 'draggable="true"' : ''}>
    <td><button class="row-play" data-action="play" data-id="${escapeHtml(song.id)}" aria-label="Play ${escapeHtml(song.title)}">▶</button></td>
    <td><div class="row-track"><div class="row-cover" style="${coverStyle(song)}">♫</div><div class="row-title"><b>${escapeHtml(song.title)}</b><small>${escapeHtml(song.artist)}</small></div></div></td>
    <td>${escapeHtml(song.album)}</td><td>${escapeHtml(song.addedLabel)}</td>
    <td><div class="row-actions">${state.view==='playlist'?`<button data-action="remove-from-playlist" data-id="${escapeHtml(song.id)}" aria-label="Remove ${escapeHtml(song.title)} from playlist">×</button>`:''}<button data-action="favorite" data-id="${escapeHtml(song.id)}" aria-label="Favorite ${escapeHtml(song.title)}">${state.favorites.has(song.id) ? '♥' : '♡'}</button><span>${formatTime(song.duration)}</span></div></td>
  </tr>`).join('');
  return `<table class="track-table ${state.view==='playlist'?'playlist-table':''}"><thead><tr><th>#</th><th>Title</th><th>Album</th><th>Date added</th><th>Duration</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderHome() {
  const totalDuration = state.songs.reduce((sum,song) => sum + (song.duration || 0), 0);
  return `<div class="hero"><div class="hero-copy"><p class="eyebrow">A LITTLE MORE YOU</p><h1>Your music.<br>Your moment.</h1><p>A beautiful home for every song you love. All local, all yours.</p><div class="hero-actions"><button class="primary-btn" data-action="import">＋ Add your music</button><button class="ghost-btn" data-action="play-all">▶ Play collection</button></div></div></div>
    <div class="stats-row"><div class="stat"><b>${state.songs.length}</b><span>songs in your library</span></div><div class="stat"><b>${formatTime(totalDuration)}</b><span>of listening</span></div><div class="stat"><b>${state.playlists.length}</b><span>playlists</span></div></div>
    <div class="section-head"><h2>Recently added</h2><button data-action="view-library">View library&nbsp; →</button></div>
    ${renderTrackTable(visibleSongs().slice(0,6),{title:'Your library is waiting',copy:'Select audio files on your device to start building your personal collection.'})}`;
}
function renderLibrary() {
  return `<div class="page-heading"><div><p class="eyebrow">YOUR COLLECTION</p><h1>Music library</h1><p>${state.songs.length} ${state.songs.length === 1 ? 'track' : 'tracks'} on this device</p></div><div style="display:flex;gap:8px"><select class="preset-select" id="sort-select" aria-label="Sort library"><option value="recent" ${state.sort==='recent'?'selected':''}>Recently added</option><option value="title" ${state.sort==='title'?'selected':''}>Title A–Z</option><option value="artist" ${state.sort==='artist'?'selected':''}>Artist A–Z</option></select><button class="primary-btn" data-action="import">＋ Add music</button></div></div>
    ${renderTrackTable(visibleSongs(),{title:state.search?'No matching tracks':'Your music lives here',copy:state.search?'Try another search.':'Pick audio files from your device. Selected tracks are available for this browser session.',action:!state.search})}`;
}
function renderPlaylists() {
  const cards = state.playlists.map(item => `<article class="playlist-card" data-playlist="${escapeHtml(item.id)}" tabindex="0"><div class="card-art">♫</div><h3>${escapeHtml(item.name)}</h3><p>${item.songIds.length} ${item.songIds.length===1?'song':'songs'}</p></article>`).join('');
  return `<div class="page-heading"><div><p class="eyebrow">MADE FOR YOUR MOMENTS</p><h1>Playlists</h1><p>Collections for every mood.</p></div><button class="primary-btn" data-action="new-playlist">＋ New playlist</button></div>${state.playlists.length?`<div class="card-grid">${cards}</div>`:`<div class="empty-state"><div class="empty-symbol">▧</div><h3>Make it a playlist kind of day</h3><p>Bring together the tracks you love in your own personal collections.</p><button class="primary-btn" data-action="new-playlist">＋ Create your first playlist</button></div>`}`;
}
function renderPlaylist() {
  const playlist = state.playlists.find(item => item.id === state.playlistId);
  if (!playlist) { state.view = 'playlists'; return renderPlaylists(); }
  const songs = visibleSongs();
  return `<div class="page-heading"><div><p class="eyebrow">YOUR PLAYLIST</p><h1>${escapeHtml(playlist.name)}</h1><p>${songs.length} ${songs.length===1?'song':'songs'} · drag tracks to reorder</p></div><div style="display:flex;gap:8px"><button class="ghost-btn" data-action="rename-playlist">Rename</button><button class="primary-btn" data-action="play-all">▶ Play</button></div></div>
    <div class="section-head"><h2>Playlist tracks</h2><button data-action="add-to-playlist">＋ Add songs</button></div>${renderTrackTable(songs,{title:'This playlist is empty',copy:'Add songs from your library to get started.',action:false})}
    <div class="section-head"><button class="text-btn" data-action="delete-playlist">Delete playlist</button></div>`;
}
function renderEqualizer() {
  const bands = AudioEngine.frequencies.map((frequency,index) => `<label class="eq-band"><small id="band-value-${index}">0 dB</small><input type="range" min="-12" max="12" value="0" data-band="${index}" aria-label="${frequency>=1000?`${frequency/1000} kHz`:`${frequency} Hz`} equalizer band"><span>${frequency>=1000?`${frequency/1000}k`:frequency}</span></label>`).join('');
  return `<div class="page-heading"><div><p class="eyebrow">MAKE IT YOUR SOUND</p><h1>Equalizer</h1><p>Fine tune the details. Best with supported browsers and headphones.</p></div></div>
    <div class="eq-card"><div class="eq-toolbar"><div><span class="eyebrow">PRESET</span><br><select class="preset-select" id="eq-preset">${Object.keys(AudioEngine.presets).map(name=>`<option>${escapeHtml(name)}</option>`).join('')}${Object.keys(state.customPresets).map(name=>`<option value="custom:${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('')}<option value="Custom">Custom</option></select></div><button class="ghost-btn" data-action="save-preset">Save custom preset</button></div><div class="eq-bands">${bands}</div>
    <div class="setting-row"><div><b>Bass boost</b><small>Add a little more weight to the low end.</small></div><input class="toggle" id="bass-toggle" type="checkbox" aria-label="Bass boost"></div>
    <div class="setting-row"><div><b>Treble enhancer</b><small>Bring a touch more sparkle to the highs.</small></div><input class="toggle" id="treble-toggle" type="checkbox" aria-label="Treble enhancer"></div>
    <p style="color:#85838e;font-size:9px;line-height:1.7">Audio processing is enabled when you start playback. Equalizer support depends on your browser's Web Audio capabilities.</p></div>`;
}
function renderSettings() {
  return `<div class="page-heading"><div><p class="eyebrow">YOUR SPACE, YOUR RULES</p><h1>Settings</h1><p>Small details, set just the way you like them.</p></div></div>
    <section class="settings-card"><p class="eyebrow">PLAYBACK</p><div class="setting-row"><div><b>Default playback speed</b><small>Choose the speed new tracks start at.</small></div><select id="settings-speed"><option value="0.75">0.75×</option><option value="1">1×</option><option value="1.25">1.25×</option><option value="1.5">1.5×</option><option value="2">2×</option></select></div>
    <div class="setting-row"><div><b>Default volume</b><small>Volume is remembered on this device.</small></div><input id="settings-volume" type="range" min="0" max="1" step=".01"></div></section>
    <section class="settings-card"><p class="eyebrow">PRIVACY & STORAGE</p><div class="setting-row"><div><b>Music file access</b><small>Browsers do not grant permanent access to your music. You may need to select files again in a new session. SONIQ does not upload your files.</small></div></div>
    <div class="setting-row"><div><b>Saved data</b><small>Playlists, favorites, listening history, custom EQ presets and preferences are stored locally. Audio files are not copied or cached.</small></div><button class="ghost-btn" data-action="clear-data">Clear saved data</button></div></section>
    <section class="settings-card"><p class="eyebrow">ABOUT SONIQ</p><div class="setting-row"><div><b>Local music. A little more beautiful.</b><small>Offline-capable music player · No tracking · No streaming.</small></div><span style="font-size:10px;color:#a999cf">v1.0</span></div>
    <div class="setting-row"><div><b>Install SONIQ</b><small>Add the app to your home screen or desktop for a standalone experience.</small></div><button class="ghost-btn" data-action="install">Install</button></div></section>`;
}

function renderView() {
  const views = {
    home: renderHome,
    library: renderLibrary,
    playlists: renderPlaylists,
    playlist: renderPlaylist,
    favorites: () => `<div class="page-heading"><div><p class="eyebrow">THE ONES YOU LOVE</p><h1>Favorites</h1><p>${state.favorites.size} saved tracks</p></div></div>${renderTrackTable(visibleSongs(),{title:'Your favorites will live here',copy:'Tap the heart next to any song to keep it close.',symbol:'♡'})}`,
    recent: () => `<div class="page-heading"><div><p class="eyebrow">PICK UP WHERE YOU LEFT OFF</p><h1>Recently played</h1><p>Your listening history, just for you.</p></div></div>${renderTrackTable(visibleSongs(),{title:'A fresh start',copy:'Songs you play will show up here.'})}`,
    equalizer: renderEqualizer,
    settings: renderSettings
  };
  $('#view-container').innerHTML = (views[state.view] ?? renderHome)();
  $$('.nav-item[data-view],.mobile-link').forEach(button => button.classList.toggle('active',button.dataset.view===state.view||(state.view==='playlist'&&button.dataset.view==='playlists')));
  $('#library-count').textContent = state.songs.length;
  if (state.view==='equalizer') syncEqControls();
  if (state.view==='settings') syncSettingControls();
}

function renderNowPlaying() {
  const song = currentSong();
  $('#panel-title').textContent = song?.title ?? 'Nothing playing yet';
  $('#panel-artist').textContent = song?.artist ?? 'Pick a song to get started';
  $('#mini-title').textContent = song?.title ?? 'Choose a track';
  $('#mini-artist').textContent = song?.artist ?? 'Your local library awaits';
  const favorite = song && state.favorites.has(song.id);
  ['#panel-favorite','#mini-favorite'].forEach(selector => {
    const button = $(selector);
    button.textContent = favorite?'♥':'♡';
    button.classList.toggle('is-favorite',Boolean(favorite));
  });
  const art = $('#panel-art'), miniArt = $('#mini-art');
  if (song) { art.className='artwork'; art.style=coverStyle(song); miniArt.style=coverStyle(song); }
  else { art.className='artwork artwork-empty'; art.style=''; miniArt.style=''; }
  $('#queue-count').textContent = state.queue.length?`${state.queue.length} ${state.queue.length===1?'track':'tracks'} in your queue`:'Your queue is waiting';
  $('#queue-list').innerHTML = state.queue.slice(0,30).map(id => {
    const item = state.songs.find(entry=>entry.id===id);
    return item?`<div class="queue-item" data-id="${escapeHtml(item.id)}"><div class="queue-thumb" style="${coverStyle(item)}">♫</div><div class="queue-meta"><b>${escapeHtml(item.title)}</b><small>${escapeHtml(item.artist)}</small></div><span class="queue-time">${formatTime(item.duration)}</span></div>`:'';
  }).join('') || '<p style="color:#777681;font-size:10px;text-align:center;padding:12px">Play a song and your queue appears here.</p>';
  $('#queue-list').onclick=event=>{
    const item=event.target.closest('.queue-item');
    if(item)playSong(item.dataset.id,true);
  };
  $('#fullscreen-title').textContent = song?.title ?? 'Nothing playing';
  $('#fullscreen-artist').textContent = song?.artist ?? '';
  $('#fullscreen-art').style = song?coverStyle(song):'';
  const playing = !audio.paused && Boolean(song);
  $('#play-btn').textContent = playing?'Ⅱ':'▶';
  $('#play-btn').setAttribute('aria-label',playing?'Pause':'Play');
  $('#full-play').textContent = playing?'Ⅱ':'▶';
  document.body.classList.toggle('is-playing',playing);
  updateProgress();
  bindQueueDrag();
}
function bindQueueDrag() {
  $$('.queue-item',$('#queue-list')).forEach(item => {
    item.draggable=true;
    item.ondragstart=event=>{state.dragId=item.dataset.id;event.dataTransfer.effectAllowed='move';};
    item.ondragover=event=>event.preventDefault();
    item.ondrop=event=>{
      event.preventDefault();
      const from=state.queue.indexOf(state.dragId),to=state.queue.indexOf(item.dataset.id);
      if(from<0||to<0)return;
      const [moved]=state.queue.splice(from,1);state.queue.splice(to,0,moved);renderNowPlaying();
    };
  });
}
function updateProgress() {
  const duration=Number.isFinite(audio.duration)?audio.duration:0;
  const current=Number.isFinite(audio.currentTime)?audio.currentTime:0;
  const value=duration?current/duration*1000:0;
  ['#seek','#full-seek'].forEach(selector=>{const range=$(selector);if(range&&!state.isDragging)range.value=value;});
  $('#current-time').textContent=formatTime(current);$('#duration').textContent=formatTime(duration);
  $('#full-current').textContent=formatTime(current);$('#full-duration').textContent=formatTime(duration);
}
function setNavigation(view, addHistory=true) {
  if (state.view!==view && addHistory) {
    state.history=state.history.slice(0,state.historyIndex+1);
    state.history.push(view);state.historyIndex=state.history.length-1;
  }
  state.view=view;state.search='';$('#search').value='';renderView();
}
function navigateHistory(delta) {
  const next=state.historyIndex+delta;
  if(next<0||next>=state.history.length)return;
  state.historyIndex=next;setNavigation(state.history[next],false);
}

function makeSong(file) {
  const name=file.name.replace(/\.[^.]+$/,'');
  const [artist,...rest]=name.includes(' - ')?name.split(' - '):['',name];
  return {id:`${encodeURIComponent(file.name)}-${file.size}-${file.lastModified}`,file,url:URL.createObjectURL(file),title:rest.join(' - ')||name||'Untitled track',artist:artist||'Unknown artist',album:'Unknown album',duration:0,added:Date.now(),addedLabel:'Just now'};
}
function supportedAudio(file) { return file.type.startsWith('audio/')||/\.(mp3|wav|flac|aac|m4a|ogg|opus|oga)$/i.test(file.name); }
function importFiles(fileList) {
  const files=[...fileList],accepted=files.filter(supportedAudio),rejected=files.length-accepted.length;
  if(!accepted.length){toast(files.length?'No supported audio files were selected.':'No files selected.');return;}
  const known=new Set(state.songs.map(song=>`${song.file?.name}:${song.file?.size}:${song.file?.lastModified}`));
  let count=0;
  for(const file of accepted){
    const signature=`${file.name}:${file.size}:${file.lastModified}`;
    if(known.has(signature))continue;
    const song=makeSong(file);
    state.songs.unshift(song);known.add(signature);count++;
    readEmbeddedMetadata(file).then(metadata=>{
      if(!state.songs.includes(song))return;
      song.title=metadata.title||song.title;
      song.artist=metadata.artist||song.artist;
      song.album=metadata.album||song.album;
      song.artworkUrl=metadata.artworkUrl;
      renderView();renderNowPlaying();
      if(currentSong()===song&&!audio.paused)setMediaSession();
    }).catch(error=>console.warn(`Could not read metadata from ${file.name}:`,error));
  }
  state.queue=state.songs.map(song=>song.id);
  $('#import-dialog').close();renderView();renderNowPlaying();
  toast(`${count} ${count===1?'track':'tracks'} added${rejected?` · ${rejected} unsupported skipped`:''}`);
}

async function ensureEngine() {
  if(engine.unavailable)return true;
  if(!engine.enabled){
    try {
      await engine.initialize();
      const customName=state.settings.preset.startsWith('custom:')?state.settings.preset.slice(7):null;
      if(customName&&state.customPresets[customName])engine.applyPreset(customName,state.customPresets[customName]);
      else engine.applyPreset(state.settings.preset==='Custom'?'Normal':state.settings.preset);
      applyToneSettings();syncEqControls();
    }catch(error){
      if(!window.AudioContext&&!window.webkitAudioContext){
        engine.unavailable=true;
        toast('Equalizer is unavailable here. Audio will play without processing.');
        return true;
      }
      console.error(error);toast(error.message);return false;
    }
  }
  return true;
}
function applyToneSettings() { engine.setBass(state.settings.bass); engine.setTreble(state.settings.treble); }
async function playSong(id,fromQueue=false) {
  const song=state.songs.find(item=>item.id===id);
  if(!song?.url){toast('Select the music file again to play it.');return;}
  const resume=state.currentId===id&&audio.currentTime>0;
  state.currentId=id;
  if(!fromQueue&&!state.shuffle){const index=state.queue.indexOf(id);if(index>=0)state.queue=[...state.queue.slice(index),...state.queue.slice(0,index)];}
  if(!resume||audio.src!==song.url){audio.src=song.url;audio.currentTime=0;}
  if(await ensureEngine()){
    try{
      await audio.play();
      state.recent=[id,...state.recent.filter(item=>item!==id)].slice(0,50);
      writeStore('settings','recent',state.recent).catch(error=>{console.error(error);toast(error.message);});
      readStore('stats','plays').then(stats=>{const next=stats??{};next[id]=(next[id]??0)+1;return writeStore('stats','plays',next);}).catch(error=>console.error(error));
    }catch(error){console.error('Playback failed:',error);toast("Can't play this audio format in your browser.");}
  }
  renderNowPlaying();
}
function playNext() {
  if(!state.queue.length)return;
  if(state.shuffle){const choices=state.queue.filter(id=>id!==state.currentId);const id=choices[Math.floor(Math.random()*choices.length)]??state.currentId;if(id)playSong(id,true);return;}
  const index=state.queue.indexOf(state.currentId);
  if(index<state.queue.length-1)playSong(state.queue[index+1],true);
  else if(state.repeat==='all'&&state.queue.length)playSong(state.queue[0],true);
  else{audio.pause();state.currentId=null;renderNowPlaying();}
}
function playPrevious() {
  if(audio.currentTime>3){audio.currentTime=0;return;}
  const index=state.queue.indexOf(state.currentId);
  const previous=state.queue[index-1]??(state.repeat==='all'?state.queue.at(-1):null);
  if(previous)playSong(previous,true);
}
function togglePlay() {
  if(audio.paused){if(state.currentId)playSong(state.currentId);else if(state.queue.length)playSong(state.queue[0],true);else toast('Add some music to your library first.');}
  else audio.pause();
}
function toggleFavorite(id) {
  if(!id)return;
  if(state.favorites.has(id))state.favorites.delete(id);else state.favorites.add(id);
  writeStore('settings','favorites',[...state.favorites]).catch(error=>{console.error(error);toast(error.message);});
  renderView();renderNowPlaying();
}
function savePlaylists() { writeStore('playlists','all',state.playlists).catch(error=>{console.error(error);toast(error.message);}); }
function openPlaylistDialog(id=null) {
  playlistEditId=id;
  $('#playlist-modal-title').textContent=id?'Rename playlist':'Create a playlist';
  $('#playlist-name').value=id?(state.playlists.find(item=>item.id===id)?.name??''):'';
  $('#playlist-dialog').showModal();$('#playlist-name').focus();
}
function openAddSongsDialog() {
  const playlist=state.playlists.find(item=>item.id===state.playlistId);
  if(!playlist){toast('Choose a playlist first.');return;}
  if(!state.songs.length){toast('Add music to your library first.');return;}
  $('#add-songs-list').innerHTML=state.songs.map(song=>{
    const alreadyAdded=playlist.songIds.includes(song.id);
    return `<label class="song-choice"><input type="checkbox" name="song-id" value="${escapeHtml(song.id)}" ${alreadyAdded?'disabled':''}><span>${escapeHtml(song.title)} — ${escapeHtml(song.artist)}</span>${alreadyAdded?'<small>Added</small>':''}</label>`;
  }).join('');
  $('#add-songs-dialog').showModal();
}
function askForConfirmation(title,copy,buttonLabel,action) {
  $('#confirm-title').textContent=title;
  $('#confirm-copy').textContent=copy;
  $('#confirm-accept').textContent=buttonLabel;
  pendingConfirmation=action;
  $('#confirm-dialog').showModal();
}
function syncEqControls() {
  const preset=$('#eq-preset');if(preset)preset.value=state.settings.preset;
  engine.filters.forEach((filter,index)=>{const slider=$(`[data-band="${index}"]`),label=$(`#band-value-${index}`);if(slider)slider.value=Math.round(filter.gain.value);if(label)label.textContent=`${Math.round(filter.gain.value)} dB`;});
  const bass=$('#bass-toggle'),treble=$('#treble-toggle');
  if(bass)bass.checked=state.settings.bass;if(treble)treble.checked=state.settings.treble;
}
function syncSettingControls() {
  const speed=$('#settings-speed'),volume=$('#settings-volume');
  if(speed)speed.value=state.settings.speed;if(volume)volume.value=state.settings.volume;
}
function persistSettings() {
  writeStore('settings','preferences',state.settings).catch(error=>{console.error(error);toast(error.message);});
}
function setMediaSession() {
  if(!('mediaSession' in navigator)||!currentSong())return;
  const song=currentSong();
  try{
    navigator.mediaSession.metadata=new MediaMetadata({title:song.title,artist:song.artist,album:song.album});
    navigator.mediaSession.setActionHandler('play',togglePlay);
    navigator.mediaSession.setActionHandler('pause',()=>audio.pause());
    navigator.mediaSession.setActionHandler('nexttrack',playNext);
    navigator.mediaSession.setActionHandler('previoustrack',playPrevious);
    navigator.mediaSession.setActionHandler('seekto',detail=>{if(detail.seekTime!=null)audio.currentTime=detail.seekTime;});
  }catch(error){console.warn('Media Session controls are unavailable:',error);}
}

function renderPlaylistNav() {
  $('#playlist-nav').innerHTML=state.playlists.map(item=>`<button class="nav-item" data-playlist="${escapeHtml(item.id)}"><span class="nav-icon">♫</span>${escapeHtml(item.name)}</button>`).join('');
}
function renderVisualizer() {
  const container=$('#visualizer');
  if(!container.childElementCount)container.innerHTML=Array.from({length:28},(_,i)=>`<i style="--bar:${8+(i*13+19)%29}px;--speed:${.45+(i*7)%10/10}s;animation-delay:-${i%7/10}s"></i>`).join('');
  const draw=()=>{
    if(engine.enabled&&!audio.paused){
      const values=engine.getFrequencies();
      if(values)$$('#visualizer i').forEach((bar,index)=>bar.style.height=`${7+values[Math.floor(index/28*values.length)]/255*31}px`);
    }
    requestAnimationFrame(draw);
  };
  requestAnimationFrame(draw);
}
async function requestInstall() {
  if(!deferredInstall){toast('Use your browser menu to choose “Install app” or “Add to Home Screen”.');return;}
  await deferredInstall.prompt();await deferredInstall.userChoice;deferredInstall=null;$('#install-btn').hidden=true;
}
function saveCustomPreset() {
  if(!engine.enabled){toast('Start playback before saving an equalizer preset.');return;}
  $('#preset-name').value='';
  $('#preset-dialog').showModal();
  $('#preset-name').focus();
}
async function saveCustomPresetNamed(name) {
  try{
    const custom=await readStore('settings','custom-presets')??{};
    custom[name]=[...engine.bands];
    await writeStore('settings','custom-presets',custom);
    state.customPresets=custom;
    state.settings.preset=`custom:${name}`;
    await writeStore('settings','preferences',state.settings);
    $('#preset-dialog').close();
    renderView();
    toast(`Saved “${name}”`);
  }catch(error){console.error(error);toast(error.message);}
}
async function clearSavedData() {
  try{
    state.playlists=[];state.favorites.clear();state.recent=[];
    state.settings={volume:.8,speed:1,preset:'Normal',bass:false,treble:false};
    state.customPresets={};
    await Promise.all([writeStore('playlists','all',[]),writeStore('settings','favorites',[]),writeStore('settings','preferences',state.settings),writeStore('settings','recent',[]),writeStore('settings','custom-presets',{}),writeStore('stats','plays',{})]);
    renderPlaylistNav();setNavigation('settings');toast('Your saved SONIQ data has been cleared.');
  }catch(error){console.error(error);toast(error.message);}
}

function bindEvents() {
  document.addEventListener('click',event=>{
    const nav=event.target.closest('[data-view]');
    if(nav){setNavigation(nav.dataset.view);return;}
    const action=event.target.closest('[data-action]');
    if(action){
      const {action:name,id}=action.dataset;
      switch(name){
        case 'import':$('#import-dialog').showModal();break;
        case 'play':playSong(id);break;
        case 'play-all':{const songs=visibleSongs();if(songs.length){state.queue=songs.map(song=>song.id);playSong(state.queue[0],true);}else toast('Add music to your library first.');break;}
        case 'favorite':toggleFavorite(id);break;
        case 'view-library':setNavigation('library');break;
        case 'new-playlist':openPlaylistDialog();break;
        case 'rename-playlist':openPlaylistDialog(state.playlistId);break;
        case 'delete-playlist':askForConfirmation('Delete this playlist?','Your music files will not be affected.','Delete',()=>{state.playlists=state.playlists.filter(item=>item.id!==state.playlistId);savePlaylists();state.playlistId=null;setNavigation('playlists');renderPlaylistNav();});break;
        case 'remove-from-playlist':{const playlist=state.playlists.find(item=>item.id===state.playlistId);if(playlist){playlist.songIds=playlist.songIds.filter(songId=>songId!==id);savePlaylists();renderView();}break;}
        case 'add-to-playlist':{
          openAddSongsDialog();break;
        }
        case 'clear-data':askForConfirmation('Clear saved SONIQ data?','Playlists, favorites, listening history, custom EQ presets and preferences will be erased. Your selected music files are not affected.','Clear data',clearSavedData);break;
        case 'install':requestInstall();break;
        case 'save-preset':saveCustomPreset();break;
      }
      return;
    }
    const card=event.target.closest('[data-playlist]');
    if(card){state.playlistId=card.dataset.playlist;setNavigation('playlist');return;}
    if(event.target.closest('#play-btn,#full-play'))togglePlay();
    if(event.target.closest('#next-btn,#full-next'))playNext();
    if(event.target.closest('#previous-btn,#full-previous'))playPrevious();
    if(event.target.closest('#shuffle-btn')){state.shuffle=!state.shuffle;$('#shuffle-btn').classList.toggle('active',state.shuffle);toast(state.shuffle?'Shuffle on':'Shuffle off');}
    if(event.target.closest('#repeat-btn')){
      state.repeat=state.repeat==='off'?'all':state.repeat==='all'?'one':'off';
      const button=$('#repeat-btn');button.classList.toggle('active',state.repeat!=='off');button.textContent=state.repeat==='one'?'⟳¹':'⟳';button.setAttribute('aria-label',`Repeat ${state.repeat}`);toast(`Repeat ${state.repeat}`);
    }
    if(event.target.closest('#volume-btn')){audio.muted=!audio.muted;$('#volume-btn').textContent=audio.muted?'◌':'◖';$('#volume-btn').setAttribute('aria-label',audio.muted?'Unmute':'Mute');}
    if(event.target.closest('#panel-favorite,#mini-favorite'))toggleFavorite(state.currentId);
    if(event.target.closest('#fullscreen-btn'))$('#fullscreen-dialog').showModal();
    if(event.target.closest('#queue-toggle')){
      if(innerWidth<=820)toast(state.queue.length?`Queue: ${state.queue.length} tracks. Open SONIQ on desktop to see details.`:'Your queue is empty.');
      else $('#now-panel').scrollIntoView({behavior:'smooth'});
    }
    if(event.target.closest('#clear-queue')){state.queue=state.currentId?[state.currentId]:[];renderNowPlaying();}
    if(event.target.closest('#new-playlist-side'))openPlaylistDialog();
    if(event.target.closest('#choose-files'))$('#file-input').click();
    if(event.target.closest('#choose-folder'))$('#folder-input').click();
    if(event.target.closest('#cancel-playlist'))$('#playlist-dialog').close();
    if(event.target.closest('#cancel-add-songs'))$('#add-songs-dialog').close();
    if(event.target.closest('#cancel-preset'))$('#preset-dialog').close();
    if(event.target.closest('#confirm-cancel')){pendingConfirmation=null;$('#confirm-dialog').close();}
    if(event.target.closest('#confirm-accept')){
      const action=pendingConfirmation;pendingConfirmation=null;$('#confirm-dialog').close();
      if(action)action();
    }
    if(event.target.closest('#back-btn'))navigateHistory(-1);
    if(event.target.closest('#forward-btn'))navigateHistory(1);
  });
  $('#file-input').addEventListener('change',event=>{importFiles(event.target.files);event.target.value='';});
  $('#folder-input').addEventListener('change',event=>{importFiles(event.target.files);event.target.value='';});
  $('#search').addEventListener('input',event=>{state.search=event.target.value.trim();renderView();});
  $('#view-container').addEventListener('click',event=>{
    const card=event.target.closest('[data-playlist]');if(card){state.playlistId=card.dataset.playlist;setNavigation('playlist');}
  });
  $('#view-container').addEventListener('change',event=>{
    if(event.target.id==='sort-select'){state.sort=event.target.value;renderView();}
    if(event.target.id==='eq-preset'){
      const name=event.target.value;
      if(name==='Custom')return;
      const customName=name.startsWith('custom:')?name.slice(7):null;
      state.settings.preset=name;
      if(engine.enabled){if(customName)engine.applyPreset(customName,state.customPresets[customName]);else engine.applyPreset(name);applyToneSettings();}else toast('Start playback to enable the equalizer.');
      persistSettings();syncEqControls();
    }
    if(event.target.matches('[data-band]')){
      const index=Number(event.target.dataset.band),value=Number(event.target.value);
      if(engine.enabled)engine.setBand(index,value);
      $(`#band-value-${index}`).textContent=`${value} dB`;state.settings.preset='Custom';
      const preset=$('#eq-preset');if(preset)preset.value='Custom';persistSettings();
    }
    if(event.target.id==='bass-toggle'){state.settings.bass=event.target.checked;if(engine.enabled)engine.setBass(event.target.checked);persistSettings();}
    if(event.target.id==='treble-toggle'){state.settings.treble=event.target.checked;if(engine.enabled)engine.setTreble(event.target.checked);persistSettings();}
    if(event.target.id==='settings-speed'){state.settings.speed=Number(event.target.value);audio.playbackRate=state.settings.speed;$('#speed-select').value=event.target.value;persistSettings();}
  });
  $('#view-container').addEventListener('input',event=>{
    if(event.target.id==='settings-volume'){state.settings.volume=Number(event.target.value);audio.volume=state.settings.volume;$('#volume').value=state.settings.volume;persistSettings();}
  });
  $('#view-container').addEventListener('dragstart',event=>{
    const row=event.target.closest('tr[data-id]');if(row){dragSongId=row.dataset.id;event.dataTransfer.effectAllowed='move';}
  });
  $('#view-container').addEventListener('dragover',event=>{if(event.target.closest('tr[data-id]'))event.preventDefault();});
  $('#view-container').addEventListener('drop',event=>{
    const row=event.target.closest('tr[data-id]');if(!row||!dragSongId||state.view!=='playlist')return;
    event.preventDefault();
    const list=state.playlists.find(item=>item.id===state.playlistId);
    if(!list)return;
    const from=list.songIds.indexOf(dragSongId),to=list.songIds.indexOf(row.dataset.id);
    if(from>=0&&to>=0){const [songId]=list.songIds.splice(from,1);list.songIds.splice(to,0,songId);savePlaylists();renderView();}
    dragSongId=null;
  });
  $('#playlist-form').addEventListener('submit',event=>{
    event.preventDefault();const name=$('#playlist-name').value.trim();if(!name)return;
    if(playlistEditId){const playlist=state.playlists.find(item=>item.id===playlistEditId);if(playlist)playlist.name=name;}
    else state.playlists.push({id:crypto.randomUUID(),name,songIds:[]});
    savePlaylists();$('#playlist-dialog').close();renderView();renderPlaylistNav();$('#playlist-name').value='';
  });
  $('#add-songs-form').addEventListener('submit',event=>{
    event.preventDefault();
    const playlist=state.playlists.find(item=>item.id===state.playlistId);
    if(!playlist)return;
    const selected=$$('input[name="song-id"]:checked',$('#add-songs-list')).map(input=>input.value);
    if(!selected.length){toast('Choose at least one song.');return;}
    playlist.songIds.push(...selected.filter(id=>!playlist.songIds.includes(id)));
    savePlaylists();$('#add-songs-dialog').close();renderView();
  });
  $('#preset-form').addEventListener('submit',event=>{
    event.preventDefault();
    const name=$('#preset-name').value.trim();
    if(name)saveCustomPresetNamed(name);
  });
  for(const selector of ['#seek','#full-seek']){
    const seek=$(selector);
    seek.addEventListener('input',()=>{state.isDragging=true;if(audio.duration)audio.currentTime=Number(seek.value)/1000*audio.duration;});
    seek.addEventListener('change',()=>{state.isDragging=false;});
  }
  $('#volume').addEventListener('input',event=>{audio.volume=Number(event.target.value);audio.muted=false;state.settings.volume=audio.volume;$('#volume-btn').textContent=audio.volume===0?'◌':'◖';persistSettings();});
  $('#speed-select').addEventListener('change',event=>{audio.playbackRate=Number(event.target.value);state.settings.speed=audio.playbackRate;const speed=$('#settings-speed');if(speed)speed.value=event.target.value;persistSettings();});
  audio.addEventListener('timeupdate',updateProgress);
  audio.addEventListener('loadedmetadata',()=>{
    const song=currentSong();if(song&&audio.duration){song.duration=audio.duration;renderView();}
    updateProgress();
  });
  audio.addEventListener('play',()=>{renderNowPlaying();setMediaSession();});
  audio.addEventListener('pause',renderNowPlaying);
  audio.addEventListener('ended',()=>{
    if(state.repeat==='one'){audio.currentTime=0;audio.play().catch(error=>{console.error(error);toast('Playback could not continue.');});}
    else playNext();
  });
  audio.addEventListener('error',()=>{if(audio.error){console.error(`Audio error ${audio.error.code}: ${audio.error.message}`);toast('This format may not be supported by your browser.');}});
  document.addEventListener('keydown',event=>{
    if(['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName)||document.querySelector('dialog[open]'))return;
    if(event.code==='Space'){event.preventDefault();togglePlay();}
    if(event.code==='ArrowRight'&&event.altKey)playNext();
    if(event.code==='ArrowLeft'&&event.altKey)playPrevious();
    if(event.code==='ArrowRight'&&!event.altKey)audio.currentTime=Math.min(audio.duration||Infinity,audio.currentTime+5);
    if(event.code==='ArrowLeft'&&!event.altKey)audio.currentTime=Math.max(0,audio.currentTime-5);
    if(event.code==='ArrowUp'){audio.volume=Math.min(1,audio.volume+.05);$('#volume').value=audio.volume;}
    if(event.code==='ArrowDown'){audio.volume=Math.max(0,audio.volume-.05);$('#volume').value=audio.volume;}
  });
  window.addEventListener('beforeinstallprompt',event=>{event.preventDefault();deferredInstall=event;$('#install-btn').hidden=false;});
  $('#install-btn').addEventListener('click',requestInstall);
  window.addEventListener('dragover',event=>event.preventDefault());
  window.addEventListener('drop',event=>{event.preventDefault();if(event.dataTransfer?.files.length)importFiles(event.dataTransfer.files);});
}

async function init() {
  try{
    const [playlists,favorites,settings,recent,customPresets]=await Promise.all([
      readStore('playlists','all'),readStore('settings','favorites'),readStore('settings','preferences'),readStore('settings','recent'),readStore('settings','custom-presets')
    ]);
    state.playlists=playlists??[];state.favorites=new Set(favorites??[]);
    state.settings={...state.settings,...(settings??{})};state.recent=recent??[];state.customPresets=customPresets??{};
  }catch(error){console.error(error);toast(error.message);}
  audio.volume=state.settings.volume;audio.playbackRate=state.settings.speed;
  $('#volume').value=state.settings.volume;$('#speed-select').value=String(state.settings.speed);
  renderPlaylistNav();renderView();renderNowPlaying();bindEvents();renderVisualizer();
  if('serviceWorker'in navigator&&location.protocol!=='file:'){
    navigator.serviceWorker.register('./sw.js').catch(error=>{console.error('Offline support could not be enabled:',error);toast('Offline support could not be enabled in this browser.');});
  }
}
init();
