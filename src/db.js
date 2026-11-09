const DB_NAME = 'soniq-local';
const DB_VERSION = 3;
const STORES = ['playlists', 'settings', 'stats', 'library', 'media'];

function openDatabase() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('IndexedDB is unavailable. SONIQ cannot save your local media.'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      for (const name of STORES) {
        if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name);
      }
    };
    request.onerror = () => reject(request.error ?? new Error('Could not open SONIQ local storage.'));
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
  });
}

export function readStore(store, key) {
  return new Promise((resolve, reject) => {
    openDatabase().then(db => {
      const transaction = db.transaction(store);
      const get = transaction.objectStore(store).get(key);
      get.onsuccess = () => resolve(get.result);
      get.onerror = () => reject(get.error ?? new Error(`Could not read ${store}.`));
      transaction.oncomplete = () => db.close();
      transaction.onerror = () => reject(transaction.error ?? new Error(`Could not read ${store}.`));
    }).catch(reject);
  });
}

export function writeStore(store, key, value) {
  return new Promise((resolve, reject) => {
    openDatabase().then(db => {
      const transaction = db.transaction(store, 'readwrite');
      transaction.objectStore(store).put(value, key);
      transaction.oncomplete = () => { db.close(); resolve(); };
      transaction.onerror = () => reject(transaction.error ?? new Error(`Could not save ${store}.`));
      transaction.onabort = () => reject(transaction.error ?? new Error(`Saving ${store} was cancelled.`));
    }).catch(reject);
  });
}

export async function readAllMedia() {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('media');
    const request = transaction.objectStore('media').getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not read saved media files.'));
    transaction.oncomplete = () => db.close();
    transaction.onerror = () => reject(transaction.error ?? new Error('Could not read saved media files.'));
  });
}

export async function saveMedia(id, blob, metadata, metadataKey) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['library', 'media'], 'readwrite');
    const library = transaction.objectStore('library');
    const media = transaction.objectStore('media');
    const request = library.get(metadataKey);
    request.onsuccess = () => {
      const items = request.result ?? [];
      const index = items.findIndex(item => item.id === id);
      if (index === -1) items.unshift(metadata);
      else items[index] = metadata;
      library.put(items, metadataKey);
      media.put({ id, blob, type: blob.type }, id);
    };
    request.onerror = () => transaction.abort();
    transaction.oncomplete = () => { db.close(); resolve(); };
    transaction.onerror = () => {
      db.close();
      reject(transaction.error ?? new Error(`Could not save ${metadata.fileName}.`));
    };
    transaction.onabort = () => {
      const error = transaction.error ?? new Error(`Could not save ${metadata.fileName}.`);
      db.close();
      reject(error);
    };
  });
}

export async function deleteMedia(id, metadataKey) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const stores = ['library', 'media', 'playlists', 'settings', 'stats'];
    const transaction = db.transaction(stores, 'readwrite');
    const library = transaction.objectStore('library');
    const request = library.get(metadataKey);
    request.onsuccess = () => {
      library.put((request.result ?? []).filter(item => item.id !== id), metadataKey);
      transaction.objectStore('media').delete(id);

      const playlists = transaction.objectStore('playlists');
      const playlistRequest = playlists.get('all');
      playlistRequest.onsuccess = () => playlists.put(
        (playlistRequest.result ?? []).map(list => ({
          ...list,
          songIds: (list.songIds ?? []).filter(songId => songId !== id)
        })),
        'all'
      );

      const settings = transaction.objectStore('settings');
      for (const key of ['favorites', 'recent']) {
        const settingRequest = settings.get(key);
        settingRequest.onsuccess = () => {
          if (Array.isArray(settingRequest.result)) {
            settings.put(settingRequest.result.filter(itemId => itemId !== id), key);
          }
        };
      }

      const stats = transaction.objectStore('stats');
      const positionsRequest = stats.get('video-positions');
      positionsRequest.onsuccess = () => {
        const positions = positionsRequest.result ?? {};
        delete positions[id];
        stats.put(positions, 'video-positions');
      };
    };
    request.onerror = () => transaction.abort();
    transaction.oncomplete = () => { db.close(); resolve(); };
    transaction.onerror = () => {
      db.close();
      reject(transaction.error ?? new Error('Could not remove the media file.'));
    };
    transaction.onabort = () => {
      const error = transaction.error ?? new Error('Could not remove the media file.');
      db.close();
      reject(error);
    };
  });
}
