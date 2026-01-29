(function () {
  "use strict";

  var DB_NAME = "logs";
  var DB_VERSION = 3;
  var STORE_NAME = "logs";
  var dbPromise = null;

  function requireIdb() {
    if (!window.indexedDB) {
      return Promise.reject(new Error("IndexedDB is not supported"));
    }
    if (!window.idb || typeof window.idb.openDB !== "function") {
      return Promise.reject(new Error("idb library is not loaded"));
    }
    return null;
  }

  function open() {
    if (dbPromise) {
      return dbPromise;
    }
    var err = requireIdb();
    if (err) {
      return err;
    }
    dbPromise = window.idb.openDB(DB_NAME, DB_VERSION, {
      upgrade: function (db) {
        if (db.objectStoreNames.contains("entries")) {
          db.deleteObjectStore("entries");
        }
        if (db.objectStoreNames.contains(STORE_NAME)) {
          db.deleteObjectStore(STORE_NAME);
        }
        var store = db.createObjectStore(STORE_NAME, {
          keyPath: "_pk",
          autoIncrement: true,
        });
        store.createIndex("log", "log", { unique: false });
        store.createIndex("timestamp", "timestamp", { unique: false });
      },
    });
    return dbPromise;
  }

  function deleteDb() {
    var err = requireIdb();
    if (err) {
      return err;
    }
    if (dbPromise) {
      dbPromise.then(function (db) {
        db.close();
      });
      dbPromise = null;
    }
    return new Promise(function (resolve, reject) {
      window.idb
        .deleteDB(DB_NAME, {
          blocked: function () {
            reject(new Error("Logs DB delete is blocked"));
          },
        })
        .then(resolve)
        .catch(function (error) {
          reject(error || new Error("Failed to delete logs DB"));
        });
    });
  }

  function clearStore() {
    return open()
      .then(function (db) {
        var tx = db.transaction(STORE_NAME, "readwrite");
        tx.store.clear();
        return tx.done;
      })
      .catch(function (error) {
        throw error || new Error("Failed to clear logs store");
      });
  }

  function addBatch(entries) {
    if (!Array.isArray(entries) || entries.length === 0) {
      return Promise.resolve();
    }
    return open()
      .then(function (db) {
        var tx = db.transaction(STORE_NAME, "readwrite");
        var store = tx.store;
        entries.forEach(function (entry) {
          if (entry && typeof entry === "object") {
            store.add(entry);
          }
        });
        return tx.done;
      })
      .catch(function (error) {
        throw error || new Error("Failed to write log batch");
      });
  }

  function iterateCursor(cursorPromise, onValue) {
    return cursorPromise.then(function loop(cursor) {
      if (!cursor) {
        return;
      }
      onValue(cursor.value);
      return cursor.continue().then(loop);
    });
  }

  function forEachInIndex(indexName, key, onEntry) {
    return open().then(function (db) {
      var tx = db.transaction(STORE_NAME, "readonly");
      var index = tx.store.index(indexName);
      var range = window.IDBKeyRange.only(key);
      return iterateCursor(index.openCursor(range), function (entry) {
        onEntry(entry);
      })
        .then(function () {
          return tx.done;
        })
        .catch(function (error) {
          throw error || new Error("Failed to read logs index");
        });
    });
  }

  function forEachStore(onEntry) {
    return open().then(function (db) {
      var tx = db.transaction(STORE_NAME, "readonly");
      return iterateCursor(tx.store.openCursor(), function (entry) {
        onEntry(entry);
      })
        .then(function () {
          return tx.done;
        })
        .catch(function (error) {
          throw error || new Error("Failed to scan logs store");
        });
    });
  }

  window.logsDb = {
    open: open,
    deleteDb: deleteDb,
    clearStore: clearStore,
    addBatch: addBatch,
    forEachInIndex: forEachInIndex,
    forEachStore: forEachStore,
  };
})();
