/**
 * This browser's vault.
 *
 * One IndexedDB database with two stores, both holding `CryptoKey` handles
 * rather than key material: `device` for the identity this browser signs in
 * with, `keys` for the Space keys, when the reader has asked to stay
 * unlocked. Every key in both was generated or derived NON-EXTRACTABLE, so
 * script on this origin can sign and decrypt with them and cannot read their
 * bytes out — which is the whole reason this is IndexedDB and not
 * `localStorage`, a store that can only hold strings and would therefore
 * force the secrets into the clear.
 *
 * Both stores live in one database because they share a version. Two modules
 * opening the same name at different versions deadlock the upgrade.
 */

const DB_NAME = "pistachio";
const DB_VERSION = 2;

export const DEVICE_STORE = "device";
export const KEYS_STORE = "keys";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      // Additive, and guarded: v1 databases already hold an enrolled identity
      // in `device`, and upgrading must not cost the reader a re-enrolment.
      for (const store of [DEVICE_STORE, KEYS_STORE]) {
        if (!request.result.objectStoreNames.contains(store)) request.result.createObjectStore(store);
      }
    };
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error ?? new Error("indexeddb unavailable"));
    };
  });
}

export async function withStore<T>(
  store: string,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest,
): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(store, mode);
      const request = run(tx.objectStore(store));
      let result: T | undefined;
      request.onsuccess = () => {
        result = request.result as T;
      };
      request.onerror = () => {
        reject(request.error ?? new Error("indexeddb request failed"));
      };
      // A successful request is not yet a durable one: the transaction it
      // belongs to can still abort, and the write goes back with it. Callers
      // that delete a key have to be able to trust that it is gone, so the
      // promise settles on the TRANSACTION, not on the request.
      tx.oncomplete = () => {
        resolve(result as T);
      };
      tx.onabort = () => {
        reject(tx.error ?? new Error("indexeddb transaction aborted"));
      };
      tx.onerror = () => {
        reject(tx.error ?? new Error("indexeddb transaction failed"));
      };
    });
  } finally {
    db.close();
  }
}
