export class MemoryStorage {
  constructor() {
    this.data = new Map();
  }

  get length() {
    return this.data.size;
  }

  key(index) {
    return [...this.data.keys()][index] ?? null;
  }

  getItem(key) {
    return this.data.has(String(key)) ? this.data.get(String(key)) : null;
  }

  setItem(key, value) {
    this.data.set(String(key), String(value));
  }

  removeItem(key) {
    this.data.delete(String(key));
  }

  clear() {
    this.data.clear();
  }
}

export function installBrowser({ href = 'http://localhost/', cfg = null } = {}) {
  const storage = new MemoryStorage();
  globalThis.localStorage = storage;
  globalThis.sessionStorage = new MemoryStorage();
  globalThis.location = new URL(href);
  globalThis.window = {
    dispatchEvent() {},
    addEventListener() {},
    removeEventListener() {},
  };
  globalThis.document = {
    visibilityState: 'visible',
    activeElement: null,
    body: { contains() { return false; } },
    addEventListener() {},
    removeEventListener() {},
  };
  if (cfg) storage.setItem('wb_supa_cfg', JSON.stringify(cfg));
  return storage;
}
