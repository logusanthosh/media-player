# SONIQ

SONIQ is a local-first, video-first media player PWA built with browser APIs and vanilla JavaScript. It has no runtime dependencies and does not upload or cache selected media files. Video is the primary player; a separate Audio section provides basic playback and local playlists.

## Run locally

Install Node.js, then run:

```sh
npm start
```

Open [http://127.0.0.1:4173](http://127.0.0.1:4173). The local server is needed for ES modules and service-worker support; no internet connection is required.

Select video and audio files (or a folder where supported) each time the browser session starts. Browsers do not grant SONIQ permanent access to the device's media folders, so saved library entries need files to be selected again before playback. Library details, playlists, favorites, watch history, and video playback positions are saved in IndexedDB on that device. SONIQ uses native browser media codecs: supported formats, folder selection, picture-in-picture, installation, and background playback vary by browser and device. The service worker caches only the application shell, never selected media.

The video player keeps playback, seeking, previous/next, fullscreen, and a compact options menu. Playback speed, Night Mode, visible option choices, and background-play/lock-screen preferences are saved in IndexedDB. Screenshot capture and lock-screen/background playback depend on browser support; background playback is enabled from the player before returning to the library.
