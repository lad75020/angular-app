(function () {
  "use strict";

  angular
    .module("app", [])
    .controller("AuthController", function ($http, $scope, $timeout) {
      var vm = this;
      vm.signupForm = { email: "", password: "" };
      vm.loginForm = { email: "", password: "" };
      vm.user = null;
      vm.message = "";
      vm.alertClass = "alert-info";

      var path = window.location.pathname;
      vm.isBazaarPage = path.indexOf("/bazaar") === 0;
      vm.isAdminPage = path.indexOf("/admin") === 0;
      vm.isRevivesPage = path.indexOf("/revives") === 0;
      vm.items = [];
      vm.itemsById = {};
      vm.itemTypes = [];
      vm.selectedType = "All";
      vm.bazaarQuery = "";
      vm.bazaarStatus = { items: "disconnected", prices: "disconnected" };
      vm.itemsError = "";
      vm.wsItems = null;
      vm.wsPrices = null;
      vm.watchQueue = [];
      vm.watchInterval = null;
      vm.wsToken = "";
      vm.wsTokenPromise = null;
      vm.wsAuthFailed = false;
      vm.priceHistoryCache = {};
      vm.priceHistoryUnavailable = {};
      vm.pendingChartItemId = null;
      vm.pendingChartTimer = null;
      vm.dailyAveragesRequested = false;
      vm.dailyAveragesLoaded = false;
      vm.dailyAveragesLoading = false;
      vm.logsDbPromise = null;
      vm.logsLoading = false;
      vm.logsRequestId = null;
      vm.logsPending = false;
      vm.logsReceivedCount = 0;
      vm.toast = { show: false, message: "" };
      vm.toastTimer = null;
      vm.revives = { granularity: "daily", loading: false, empty: false };
      vm.chart = { open: false, title: "", points: [] };
      vm.wsCredentials = { login: "", password: "" };
      vm.navAction = "";

      function setMessage(message, alertClass) {
        if (!message) {
          vm.message = "";
          vm.alertClass = alertClass || "alert-info";
          return;
        }
        vm.message = "";
        vm.alertClass = alertClass || "alert-info";
        showToast(message);
      }

      function applyAsync(fn) {
        $scope.$applyAsync(fn);
      }

      function showToast(message) {
        vm.toast.message = message;
        vm.toast.show = true;
        if (vm.toastTimer) {
          $timeout.cancel(vm.toastTimer);
        }
        vm.toastTimer = $timeout(function () {
          vm.toast.show = false;
        }, 3000);
      }

      function openLogsDb() {
        if (vm.logsDbPromise) {
          return vm.logsDbPromise;
        }
        vm.logsDbPromise = new Promise(function (resolve, reject) {
          if (!window.indexedDB) {
            reject(new Error("IndexedDB is not supported"));
            return;
          }
          var request = window.indexedDB.open("logs", 3);
          request.onupgradeneeded = function (event) {
            var db = event.target.result;
            if (db.objectStoreNames.contains("entries")) {
              db.deleteObjectStore("entries");
            }
            if (db.objectStoreNames.contains("logs")) {
              db.deleteObjectStore("logs");
            }
            var store = db.createObjectStore("logs", {
              keyPath: "_pk",
              autoIncrement: true,
            });
            store.createIndex("log", "log", { unique: false });
            store.createIndex("timestamp", "timestamp", { unique: false });
          };
          request.onsuccess = function () {
            resolve(request.result);
          };
          request.onerror = function () {
            reject(request.error || new Error("Failed to open IndexedDB"));
          };
        });
        return vm.logsDbPromise;
      }

      function deleteLogsDb() {
        return new Promise(function (resolve, reject) {
          if (!window.indexedDB) {
            reject(new Error("IndexedDB is not supported"));
            return;
          }
          if (vm.logsDbPromise) {
            vm.logsDbPromise.then(function (db) {
              db.close();
            });
            vm.logsDbPromise = null;
          }
          var request = window.indexedDB.deleteDatabase("logs");
          request.onsuccess = function () {
            resolve();
          };
          request.onerror = function () {
            reject(request.error || new Error("Failed to delete logs DB"));
          };
          request.onblocked = function () {
            reject(new Error("Logs DB delete is blocked"));
          };
        });
      }

      function clearLogsStore() {
        return openLogsDb().then(function (db) {
          return new Promise(function (resolve, reject) {
            var tx = db.transaction("logs", "readwrite");
            tx.objectStore("logs").clear();
            tx.oncomplete = function () {
              resolve();
            };
            tx.onerror = function () {
              reject(tx.error || new Error("Failed to clear logs store"));
            };
          });
        });
      }

      function addLogsBatch(entries) {
        if (!Array.isArray(entries) || entries.length === 0) {
          return Promise.resolve();
        }
        return openLogsDb().then(function (db) {
          return new Promise(function (resolve, reject) {
            var tx = db.transaction("logs", "readwrite");
            var store = tx.objectStore("logs");
            entries.forEach(function (entry) {
              if (entry && typeof entry === "object") {
                store.add(entry);
              }
            });
            tx.oncomplete = function () {
              resolve();
            };
            tx.onerror = function () {
              reject(tx.error || new Error("Failed to write log batch"));
            };
          });
        });
      }

      function beginLogsFetch() {
        if (vm.logsLoading) {
          return;
        }
        vm.logsLoading = true;
        vm.logsRequestId = "logs-" + Date.now();
        vm.logsReceivedCount = 0;
        deleteLogsDb()
          .then(function () {
            return openLogsDb();
          })
          .then(function () {
            return clearLogsStore();
          })
          .then(function () {
            vm.wsItems.send(
              JSON.stringify({
                type: "getAllTornLogs",
                requestId: vm.logsRequestId,
              })
            );
            setMessage("Fetching logs...", "alert-info");
          })
          .catch(function () {
            vm.logsLoading = false;
            setMessage("Failed to open logs database.", "alert-danger");
          });
      }

      function normalizeItem(raw) {
        if (!raw || typeof raw !== "object") {
          return null;
        }
        var id =
          raw.id ||
          raw.itemId ||
          raw.item_id ||
          raw.tornId ||
          raw.torn_id;
        var name = raw.name || raw.itemName || raw.title || "Unknown item";
        var description = raw.description || raw.desc || raw.tooltip || "";
        var img64 = raw.img64 || raw.image64 || raw.image || raw.img || "";
        var type = raw.type || raw.itemType || raw.category || raw.group || "";
        return {
          id: typeof id === "string" ? Number(id) || id : id,
          name: name,
          description: description,
          img64: img64,
          type: type,
          price: raw.price || raw.minBazaar || raw.marketValue || null,
        };
      }

      vm.itemImageSrc = function (item) {
        if (!item) {
          return "";
        }
        var img = item.img64;
        if (!img) {
          return "";
        }
        if (img.indexOf("data:") === 0 || img.indexOf("http") === 0) {
          return img;
        }
        return "data:image/png;base64," + img;
      };

      vm.formatPrice = function (item) {
        if (!item || item.price === null || typeof item.price === "undefined") {
          return "—";
        }
        var numeric = Number(item.price);
        if (Number.isNaN(numeric)) {
          return "—";
        }
        return "$" + numeric.toLocaleString();
      };

      vm.statusClass = function (status) {
        switch (status) {
          case "connected":
            return "bg-success";
          case "connecting":
            return "bg-warning text-dark";
          case "error":
            return "bg-danger";
          default:
            return "bg-secondary";
        }
      };

      function formatDateLabel(value) {
        if (!value) {
          return "";
        }
        var date = new Date(value);
        if (Number.isNaN(date.getTime())) {
          return String(value);
        }
        return date.toLocaleDateString();
      }

      function normalizePoint(point) {
        if (!point || typeof point !== "object") {
          return null;
        }
        var value =
          point.avg ||
          point.value ||
          point.average ||
          point.price ||
          point.dailyAverage ||
          point.mean;
        if (typeof value === "string") {
          value = Number(value);
        }
        if (!Number.isFinite(value)) {
          return null;
        }
        var date = point.date || point.day || point.time || point.timestamp || point.ts;
        if (typeof date === "number") {
          if (date < 1e12) {
            date = date * 1000;
          }
          date = new Date(date);
        }
        if (date instanceof Date && !Number.isNaN(date.getTime())) {
          date = date.toISOString().slice(0, 10);
        }
        if (!date) {
          return null;
        }
        return { date: String(date), value: value };
      }

      function buildDailyPriceMapFromPayload(payload) {
        var map = {};
        if (!payload || typeof payload !== "object") {
          return map;
        }

        var candidates = [];
        if (Array.isArray(payload.points)) {
          candidates = payload.points;
        } else if (Array.isArray(payload.items)) {
          candidates = payload.items;
        } else if (Array.isArray(payload.lines)) {
          candidates = payload.lines;
        } else if (payload.data && typeof payload.data === "object") {
          Object.keys(payload.data).forEach(function (key) {
            candidates.push({ id: key, point: payload.data[key] });
          });
        }

        if (candidates.length) {
          candidates.forEach(function (entry) {
            if (!entry || typeof entry !== "object") {
              return;
            }
            var id =
              entry.id ||
              entry.itemId ||
              entry.item_id ||
              entry.tornId ||
              entry.torn_id;
            if (typeof id === "string") {
              id = Number(id) || id;
            }
            var points = entry.points || entry.point || entry.data;
            if (!Array.isArray(points)) {
              var maybeSingle = normalizePoint(entry);
              if (maybeSingle) {
                if (!map[id]) {
                  map[id] = [];
                }
                map[id].push(maybeSingle);
              }
              return;
            }
            points.forEach(function (point) {
              var normalized = normalizePoint(point);
              if (!normalized) {
                return;
              }
              if (!map[id]) {
                map[id] = [];
              }
              map[id].push(normalized);
            });
          });
        }

        Object.keys(map).forEach(function (id) {
          map[id].sort(function (a, b) {
            return (
              new Date(a.date).getTime() - new Date(b.date).getTime()
            );
          });
        });
        return map;
      }

      function drawChart(points) {
        var canvas = document.getElementById("priceChart");
        if (!canvas || !points || !points.length) {
          return;
        }
        var ctx = canvas.getContext("2d");
        var width = canvas.width;
        var height = canvas.height;
        var margin = { top: 24, right: 24, bottom: 44, left: 60 };
        var chartWidth = width - margin.left - margin.right;
        var chartHeight = height - margin.top - margin.bottom;

        ctx.clearRect(0, 0, width, height);
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, width, height);

        var values = points.map(function (point) {
          return point.value;
        });
        var min = Math.min.apply(null, values);
        var max = Math.max.apply(null, values);
        if (min === max) {
          min = min - 1;
          max = max + 1;
        }

        ctx.strokeStyle = "#e2e8f0";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(margin.left, margin.top);
        ctx.lineTo(margin.left, margin.top + chartHeight);
        ctx.lineTo(margin.left + chartWidth, margin.top + chartHeight);
        ctx.stroke();

        var ticks = 4;
        ctx.fillStyle = "#64748b";
        ctx.font = "12px Segoe UI, system-ui, sans-serif";
        for (var i = 0; i <= ticks; i += 1) {
          var yValue = min + ((max - min) * i) / ticks;
          var yPos =
            margin.top + chartHeight - (chartHeight * i) / ticks;
          ctx.fillText(
            "$" + Math.round(yValue).toLocaleString(),
            10,
            yPos + 4
          );
          ctx.strokeStyle = "rgba(148, 163, 184, 0.25)";
          ctx.beginPath();
          ctx.moveTo(margin.left, yPos);
          ctx.lineTo(margin.left + chartWidth, yPos);
          ctx.stroke();
        }

        var stepX = points.length > 1 ? chartWidth / (points.length - 1) : 0;
        ctx.strokeStyle = "#0f766e";
        ctx.lineWidth = 2;
        ctx.beginPath();
        points.forEach(function (point, index) {
          var x = margin.left + stepX * index;
          var y =
            margin.top +
            chartHeight -
            ((point.value - min) / (max - min)) * chartHeight;
          if (index === 0) {
            ctx.moveTo(x, y);
          } else {
            ctx.lineTo(x, y);
          }
        });
        ctx.stroke();

        ctx.fillStyle = "#0f766e";
        points.forEach(function (point, index) {
          var x = margin.left + stepX * index;
          var y =
            margin.top +
            chartHeight -
            ((point.value - min) / (max - min)) * chartHeight;
          ctx.beginPath();
          ctx.arc(x, y, 3, 0, Math.PI * 2);
          ctx.fill();
        });

        ctx.fillStyle = "#475569";
        ctx.font = "11px Segoe UI, system-ui, sans-serif";
        if (points.length) {
          var first = points[0];
          var mid = points[Math.floor(points.length / 2)];
          var last = points[points.length - 1];
          ctx.fillText(formatDateLabel(first.date), margin.left, height - 14);
          ctx.fillText(
            formatDateLabel(mid.date),
            margin.left + chartWidth / 2 - 20,
            height - 14
          );
          ctx.fillText(
            formatDateLabel(last.date),
            margin.left + chartWidth - 70,
            height - 14
          );
        }
      }

      function showChart(item, points) {
        applyAsync(function () {
          vm.chart.open = true;
          vm.chart.title = item.name + " (ID " + item.id + ")";
          vm.chart.points = points;
        });
        $timeout(function () {
          drawChart(points);
        }, 0);
      }

      vm.clearSearch = function () {
        vm.bazaarQuery = "";
      };

      vm.itemFilter = function (item) {
        if (!vm.bazaarQuery) {
          if (vm.selectedType && vm.selectedType !== "All") {
            return item.type === vm.selectedType;
          }
          return true;
        }
        var q = vm.bazaarQuery.toLowerCase();
        var matchesText =
          (item.name || "").toLowerCase().indexOf(q) !== -1 ||
          String(item.id || "").indexOf(q) !== -1;
        if (vm.selectedType && vm.selectedType !== "All") {
          return matchesText && item.type === vm.selectedType;
        }
        return matchesText;
      };

      function buildWsUrl(path, token) {
        var base = "wss://torn.dubertrand.fr";
        if (token) {
          return base + path + "?token=" + encodeURIComponent(token);
        }
        return base + path;
      }

      function startWatchInterval() {
        if (vm.watchInterval) {
          return;
        }
        vm.watchInterval = setInterval(function () {
          if (!vm.wsPrices || vm.wsPrices.readyState !== WebSocket.OPEN) {
            return;
          }
          if (vm.watchQueue.length === 0) {
            clearInterval(vm.watchInterval);
            vm.watchInterval = null;
            return;
          }
          var nextId = vm.watchQueue.shift();
          if (typeof nextId === "undefined" || nextId === null) {
            return;
          }
          vm.wsPrices.send(
            JSON.stringify({ type: "watch", itemId: Number(nextId) })
          );
        }, 80);
      }

      function enqueueWatchAll() {
        if (!vm.items.length) {
          return;
        }
        vm.watchQueue = vm.items
          .map(function (item) {
            return item.id;
          })
          .filter(function (id) {
            return id !== null && typeof id !== "undefined" && id !== "";
          });
        startWatchInterval();
      }

      function handlePriceUpdate(data) {
        var itemId = typeof data.itemId !== "undefined" ? data.itemId : data.id;
        if (typeof itemId === "string") {
          itemId = Number(itemId) || itemId;
        }
        var price =
          typeof data.minBazaar !== "undefined" ? data.minBazaar : data.price;
        if ((price === null || typeof price === "undefined") && data.listings) {
          if (data.listings.length) {
            price = data.listings[0].price;
          }
        }
        applyAsync(function () {
          var item = vm.itemsById[itemId];
          if (item) {
            if (data.itemName && !item.name) {
              item.name = data.itemName;
            }
            item.price = price;
          }
        });
      }

      function connectItemsSocket() {
        if (
          vm.wsItems &&
          (vm.wsItems.readyState === WebSocket.OPEN ||
            vm.wsItems.readyState === WebSocket.CONNECTING)
        ) {
          return;
        }
        if (!vm.wsToken) {
          vm.bazaarStatus.items = "connecting";
          if (!vm.wsTokenPromise) {
            vm.wsTokenPromise = $http
              .post("/api/user/ws-token")
              .then(function (response) {
                vm.wsToken = response.data.token;
                vm.wsTokenPromise = null;
                vm.wsAuthFailed = false;
                connectItemsSocket();
              })
              .catch(function (error) {
                vm.wsTokenPromise = null;
                vm.wsAuthFailed = true;
                var message =
                  (error.data && error.data.error) ||
                  "Failed to authenticate websocket.";
                setMessage(message, "alert-danger");
                applyAsync(function () {
                  vm.bazaarStatus.items = "error";
                });
              });
          }
          return;
        }
        vm.bazaarStatus.items = "connecting";
        vm.itemsError = "";
        var ws = new WebSocket(buildWsUrl("/ws", vm.wsToken));
        vm.wsItems = ws;

        ws.onopen = function () {
          applyAsync(function () {
            vm.bazaarStatus.items = "connected";
          });
          ws.send(JSON.stringify({ type: "getAllTornItems" }));
          if (vm.logsPending) {
            vm.logsPending = false;
            beginLogsFetch();
          }
        };

        ws.onmessage = function (event) {
          var payload;
          try {
            payload = JSON.parse(event.data);
          } catch (err) {
            if (vm.pendingChartItemId && vm.itemsById[vm.pendingChartItemId]) {
              applyAsync(function () {
                vm.itemsById[vm.pendingChartItemId].chartLoading = false;
              });
              vm.pendingChartItemId = null;
              setMessage("Unexpected response from server.", "alert-warning");
            }
            return;
          }
          if (payload.type === "getAllTornItems") {
            if (payload.ok && Array.isArray(payload.items)) {
              var normalized = payload.items
                .map(normalizeItem)
                .filter(Boolean)
                .sort(function (a, b) {
                  return a.name.localeCompare(b.name);
                });
              applyAsync(function () {
                vm.items = normalized;
                vm.itemsById = {};
                vm.itemTypes = ["All"];
                vm.items.forEach(function (item) {
                  vm.itemsById[item.id] = item;
                  if (item.type && vm.itemTypes.indexOf(item.type) === -1) {
                    vm.itemTypes.push(item.type);
                  }
                });
              });
              enqueueWatchAll();
              if (!vm.dailyAveragesRequested) {
                vm.dailyAveragesRequested = true;
                vm.dailyAveragesLoading = true;
                ws.send(JSON.stringify({ type: "dailyPriceAveragesAll" }));
              }
            } else if (payload.error) {
              applyAsync(function () {
                vm.itemsError = payload.error;
              });
            }
          } else if (payload.type === "dailyPriceAveragesAll") {
            console.log("[dailyPriceAveragesAll] payload:", payload);
            var pendingId = vm.pendingChartItemId;
            if (payload.ok === false) {
              vm.dailyAveragesLoading = false;
              vm.dailyAveragesLoaded = false;
              applyAsync(function () {
                if (pendingId && vm.itemsById[pendingId]) {
                  vm.itemsById[pendingId].chartLoading = false;
                }
              });
              if (vm.pendingChartTimer) {
                $timeout.cancel(vm.pendingChartTimer);
                vm.pendingChartTimer = null;
              }
              vm.pendingChartItemId = null;
              setMessage(payload.error || "No daily average data.", "alert-danger");
              return;
            }
            vm.dailyAveragesLoading = false;
            vm.dailyAveragesLoaded = true;
            var map = buildDailyPriceMapFromPayload(payload);
            Object.keys(map).forEach(function (key) {
              vm.priceHistoryCache[key] = map[key];
            });
            applyAsync(function () {
              if (pendingId && vm.itemsById[pendingId]) {
                vm.itemsById[pendingId].chartLoading = false;
              }
            });
            if (vm.pendingChartTimer) {
              $timeout.cancel(vm.pendingChartTimer);
              vm.pendingChartTimer = null;
            }
            if (pendingId) {
              var points = map[pendingId] || [];
              if (!points.length) {
                applyAsync(function () {
                  vm.priceHistoryUnavailable[pendingId] = true;
                });
                vm.pendingChartItemId = null;
                return;
              }
              vm.priceHistoryCache[pendingId] = points;
              showChart(vm.itemsById[pendingId], points);
              vm.pendingChartItemId = null;
            }
          } else if (payload.type === "getAllTornLogs") {
            if (!vm.logsRequestId && !vm.logsLoading) {
              return;
            }
            if (
              payload.requestId &&
              vm.logsRequestId &&
              payload.requestId !== vm.logsRequestId
            ) {
              return;
            }
            if (payload.error) {
              vm.logsLoading = false;
              vm.logsRequestId = null;
              setMessage(payload.error, "alert-danger");
              return;
            }
            if (payload.phase !== "batch") {
              return;
            }
            var sentCount = Number(payload.sent);
            var totalCount = Number(payload.total);
            var isDone =
              Number.isFinite(sentCount) &&
              Number.isFinite(totalCount) &&
              totalCount > 0 &&
              sentCount >= totalCount;
            var batchEntries = payload.batch || [];
            vm.logsReceivedCount += batchEntries.length;
            addLogsBatch(batchEntries)
              .then(function () {
                if (isDone) {
                  vm.logsLoading = false;
                  vm.logsRequestId = null;
                  setMessage("Logs stored in IndexedDB.", "alert-success");
                  showToast("Logs received: " + vm.logsReceivedCount);
                }
              })
              .catch(function () {
                setMessage("Failed to store logs batch.", "alert-danger");
              });
            return;
          } else if (payload.type === "updatePrice") {
            if (payload.ok) {
              handlePriceUpdate(payload);
              applyAsync(function () {
                var updatedItem = vm.itemsById[payload.id];
                if (updatedItem && payload.price !== null) {
                  updatedItem.price = payload.price;
                }
              });
              setMessage("Price updated.", "alert-success");
            } else if (payload.error) {
              setMessage(payload.error, "alert-danger");
            }
          } else if (payload.type === "auth" && payload.error) {
            applyAsync(function () {
              vm.itemsError = payload.error;
            });
            vm.wsToken = "";
            vm.wsAuthFailed = true;
            setMessage(payload.error, "alert-danger");
          }
        };

        ws.onerror = function () {
          applyAsync(function () {
            vm.bazaarStatus.items = "error";
            vm.itemsError = "Item socket error. Please retry.";
          });
        };

        ws.onclose = function () {
          applyAsync(function () {
            vm.bazaarStatus.items = "disconnected";
            if (vm.pendingChartItemId && vm.itemsById[vm.pendingChartItemId]) {
              vm.itemsById[vm.pendingChartItemId].chartLoading = false;
            }
            vm.pendingChartItemId = null;
            vm.logsLoading = false;
            vm.logsRequestId = null;
          });
          if (vm.pendingChartTimer) {
            $timeout.cancel(vm.pendingChartTimer);
            vm.pendingChartTimer = null;
          }
          if (!vm.dailyAveragesLoaded) {
            vm.dailyAveragesRequested = false;
            vm.dailyAveragesLoading = false;
          }
          if (vm.user) {
            $timeout(connectItemsSocket, 4000);
          }
        };
      }

      function connectPricesSocket() {
        if (
          vm.wsPrices &&
          (vm.wsPrices.readyState === WebSocket.OPEN ||
            vm.wsPrices.readyState === WebSocket.CONNECTING)
        ) {
          return;
        }
        vm.bazaarStatus.prices = "connecting";
        var ws = new WebSocket(buildWsUrl("/wsb"));
        vm.wsPrices = ws;

        ws.onopen = function () {
          applyAsync(function () {
            vm.bazaarStatus.prices = "connected";
          });
          enqueueWatchAll();
        };

        ws.onmessage = function (event) {
          var payload;
          try {
            payload = JSON.parse(event.data);
          } catch (err) {
            return;
          }
          if (payload.type === "priceUpdate" || typeof payload.itemId !== "undefined") {
            handlePriceUpdate(payload);
          }
        };

        ws.onerror = function () {
          applyAsync(function () {
            vm.bazaarStatus.prices = "error";
          });
        };

        ws.onclose = function () {
          applyAsync(function () {
            vm.bazaarStatus.prices = "disconnected";
          });
          if (vm.user) {
            $timeout(connectPricesSocket, 4000);
          }
        };
      }

      vm.updatePrice = function (item) {
        if (!item) {
          return;
        }
        if (!vm.wsItems || vm.wsItems.readyState !== WebSocket.OPEN) {
          setMessage("Items socket is not connected.", "alert-warning");
          return;
        }
        var id = Number(item.id);
        if (!Number.isFinite(id)) {
          setMessage("Invalid item id.", "alert-danger");
          return;
        }
        vm.wsItems.send(JSON.stringify({ type: "updatePrice", id: id }));
        setMessage(
          "Fetching latest price for " + item.name + "...",
          "alert-info"
        );
      };

      vm.openPriceChart = function (item) {
        if (!item) {
          return;
        }
        var id = Number(item.id);
        if (!Number.isFinite(id)) {
          setMessage("Invalid item id.", "alert-danger");
          return;
        }
        if (vm.priceHistoryUnavailable[id]) {
          return;
        }
        if (vm.priceHistoryCache[id]) {
          showChart(item, vm.priceHistoryCache[id]);
          return;
        }
        if (vm.dailyAveragesLoaded) {
          vm.priceHistoryUnavailable[id] = true;
          setMessage("No daily average data for " + item.name + ".", "alert-warning");
          return;
        }
        if (!vm.wsItems || vm.wsItems.readyState !== WebSocket.OPEN) {
          setMessage("Items socket is not connected.", "alert-warning");
          return;
        }
        if (vm.pendingChartItemId) {
          return;
        }
        vm.pendingChartItemId = id;
        applyAsync(function () {
          item.chartLoading = true;
        });
        if (!vm.dailyAveragesRequested) {
          vm.dailyAveragesRequested = true;
          vm.dailyAveragesLoading = true;
          vm.wsItems.send(JSON.stringify({ type: "dailyPriceAveragesAll" }));
        }
        if (vm.pendingChartTimer) {
          $timeout.cancel(vm.pendingChartTimer);
        }
        vm.pendingChartTimer = $timeout(function () {
          if (vm.pendingChartItemId === id && item.chartLoading) {
            item.chartLoading = false;
            vm.pendingChartItemId = null;
            setMessage(
              "No daily average data returned for " + item.name + ".",
              "alert-warning"
            );
          }
        }, 6000);
      };

      vm.closeChart = function () {
        vm.chart.open = false;
      };

      vm.fetchLogs = function () {
        if (!vm.user) {
          setMessage("Please log in first.", "alert-warning");
          return;
        }
        if (!vm.wsItems || vm.wsItems.readyState !== WebSocket.OPEN) {
          vm.logsPending = true;
          connectItemsSocket();
          setMessage("Connecting to logs...", "alert-info");
          return;
        }
        beginLogsFetch();
      };

      vm.cancelLogsFetch = function () {
        vm.logsLoading = false;
        vm.logsRequestId = null;
        vm.logsPending = false;
        setMessage("Log fetch canceled.", "alert-secondary");
      };

      vm.handleNav = function () {
        var action = vm.navAction;
        vm.navAction = "";
        if (!action) {
          return;
        }
        if (action === "logs") {
          vm.fetchLogs();
          return;
        }
        if (action === "logout") {
          vm.logout();
          return;
        }
        if (action === "admin") {
          window.location.href = "/admin";
          return;
        }
        if (action === "revives") {
          window.location.href = "/revives";
          return;
        }
        if (action === "bazaar") {
          window.location.href = "/bazaar";
        }
      };

      function formatDateUTC(date) {
        var year = date.getUTCFullYear();
        var month = String(date.getUTCMonth() + 1).padStart(2, "0");
        var day = String(date.getUTCDate()).padStart(2, "0");
        return year + "-" + month + "-" + day;
      }

      function getDateKey(timestampSeconds, granularity) {
        var seconds = Number(timestampSeconds);
        if (!Number.isFinite(seconds)) {
          return null;
        }
        if (seconds > 1e12) {
          seconds = Math.floor(seconds / 1000);
        }
        var date = new Date(seconds * 1000);
        if (Number.isNaN(date.getTime())) {
          return null;
        }
        if (granularity === "weekly") {
          var day = date.getUTCDay();
          var diff = (day + 6) % 7;
          date.setUTCDate(date.getUTCDate() - diff);
        }
        return formatDateUTC(date);
      }

      function drawRevivesChart(points) {
        var canvas = document.getElementById("revivesChart");
        if (!canvas) {
          return;
        }
        var ctx = canvas.getContext("2d");
        var width = canvas.width;
        var height = canvas.height;
        ctx.clearRect(0, 0, width, height);
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, width, height);
        if (!points || !points.length) {
          return;
        }

        var margin = { top: 24, right: 24, bottom: 44, left: 60 };
        var chartWidth = width - margin.left - margin.right;
        var chartHeight = height - margin.top - margin.bottom;

        var values = points.map(function (point) {
          return point.value;
        });
        var min = 0;
        var max = Math.max.apply(null, values);
        if (!Number.isFinite(max) || max === 0) {
          max = 1;
        }

        ctx.strokeStyle = "#e2e8f0";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(margin.left, margin.top);
        ctx.lineTo(margin.left, margin.top + chartHeight);
        ctx.lineTo(margin.left + chartWidth, margin.top + chartHeight);
        ctx.stroke();

        var ticks = 4;
        ctx.fillStyle = "#64748b";
        ctx.font = "12px Segoe UI, system-ui, sans-serif";
        for (var i = 0; i <= ticks; i += 1) {
          var yValue = (max * i) / ticks;
          var yPos =
            margin.top + chartHeight - (chartHeight * i) / ticks;
          ctx.fillText(String(Math.round(yValue)), 12, yPos + 4);
          ctx.strokeStyle = "rgba(148, 163, 184, 0.25)";
          ctx.beginPath();
          ctx.moveTo(margin.left, yPos);
          ctx.lineTo(margin.left + chartWidth, yPos);
          ctx.stroke();
        }

        var barCount = points.length;
        var barGap = 6;
        var barWidth = barCount ? chartWidth / barCount - barGap : chartWidth;
        if (barWidth < 2) {
          barWidth = 2;
        }

        ctx.fillStyle = "#2563eb";
        points.forEach(function (point, index) {
          var x = margin.left + index * (barWidth + barGap) + barGap / 2;
          var barHeight = (point.value / max) * chartHeight;
          var y = margin.top + chartHeight - barHeight;
          ctx.fillRect(x, y, barWidth, barHeight);
        });

        ctx.fillStyle = "#475569";
        ctx.font = "11px Segoe UI, system-ui, sans-serif";
        if (points.length) {
          var first = points[0];
          var mid = points[Math.floor(points.length / 2)];
          var last = points[points.length - 1];
          ctx.fillText(first.date, margin.left, height - 14);
          ctx.fillText(mid.date, margin.left + chartWidth / 2 - 20, height - 14);
          ctx.fillText(last.date, margin.left + chartWidth - 70, height - 14);
        }
      }

      vm.loadRevives = function (granularity) {
        if (!vm.user) {
          return;
        }
        if (!vm.isRevivesPage) {
          return;
        }
        applyAsync(function () {
          vm.revives.loading = true;
          vm.revives.empty = false;
        });
        if (granularity) {
          vm.revives.granularity = granularity;
        }
        openLogsDb()
          .then(function (db) {
            return new Promise(function (resolve, reject) {
              var tx = db.transaction("logs", "readonly");
              var store = tx.objectStore("logs");
              var index = store.index("log");
              var range = window.IDBKeyRange.only(5410);
              var counts = {};
              var request = index.openCursor(range);
              request.onsuccess = function (event) {
                var cursor = event.target.result;
                if (!cursor) {
                  resolve(counts);
                  return;
                }
                var entry = cursor.value;
                var key = getDateKey(
                  entry && entry.timestamp,
                  vm.revives.granularity
                );
                if (key) {
                  counts[key] = (counts[key] || 0) + 1;
                }
                cursor.continue();
              };
              request.onerror = function () {
                reject(new Error("Failed to read revive logs"));
              };
              tx.onerror = function () {
                reject(tx.error || new Error("Failed to read revive logs"));
              };
            });
          })
          .then(function (counts) {
            var keys = Object.keys(counts).sort();
            var points = keys.map(function (key) {
              return { date: key, value: counts[key] };
            });
            applyAsync(function () {
              vm.revives.loading = false;
              vm.revives.empty = points.length === 0;
            });
            $timeout(function () {
              drawRevivesChart(points);
            }, 0);
          })
          .catch(function () {
            applyAsync(function () {
              vm.revives.loading = false;
              vm.revives.empty = true;
            });
          });
      };

      vm.initBazaar = function () {
        if (!vm.user || !vm.isBazaarPage) {
          return;
        }
        connectItemsSocket();
        connectPricesSocket();
      };

      vm.loadWsCredentials = function () {
        if (!vm.user || !vm.isAdminPage) {
          return;
        }
        $http.get("/api/user/ws-credentials").then(
          function (response) {
            vm.wsCredentials = response.data.credentials || {
              login: "",
              password: "",
            };
          },
          function () {
            vm.wsCredentials = { login: "", password: "" };
          }
        );
      };

      vm.saveWsCredentials = function () {
        if (!vm.user) {
          return;
        }
        setMessage("");
        $http.post("/api/user/ws-credentials", vm.wsCredentials).then(
          function () {
            setMessage("Credentials saved.", "alert-success");
          },
          function (error) {
            var message =
              (error.data && error.data.error) || "Save failed. Try again.";
            setMessage(message, "alert-danger");
          }
        );
      };

      vm.disconnectBazaar = function () {
        if (vm.wsItems) {
          vm.wsItems.close();
          vm.wsItems = null;
        }
        if (vm.wsPrices) {
          vm.wsPrices.close();
          vm.wsPrices = null;
        }
        if (vm.watchInterval) {
          clearInterval(vm.watchInterval);
          vm.watchInterval = null;
        }
        vm.watchQueue = [];
      };

      vm.fetchMe = function () {
        $http.get("/api/auth/me").then(
          function (response) {
            vm.user = response.data.user;
            vm.initBazaar();
            vm.loadWsCredentials();
            if (vm.isRevivesPage) {
              vm.loadRevives(vm.revives.granularity);
            }
          },
          function () {
            vm.user = null;
            vm.disconnectBazaar();
            if (vm.isBazaarPage) {
              window.location.href = "/";
            }
            if (vm.isAdminPage) {
              window.location.href = "/";
            }
          }
        );
      };
      vm.signup = function () {
        setMessage("");
        $http.post("/api/auth/signup", vm.signupForm).then(
          function (response) {
            vm.user = response.data.user;
            vm.signupForm = { email: "", password: "" };
            setMessage("Signup successful", "alert-success");
            window.location.href = "/bazaar";
          },
          function (error) {
            var message =
              (error.data && error.data.error) || "Signup failed. Try again.";
            setMessage(message, "alert-danger");
          }
        );
      };

      vm.login = function () {
        setMessage("");
        $http.post("/api/auth/login", vm.loginForm).then(
          function (response) {
            vm.user = response.data.user;
            vm.loginForm = { email: "", password: "" };
            setMessage("Login successful", "alert-success");
            window.location.href = "/bazaar";
          },
          function (error) {
            var message =
              (error.data && error.data.error) || "Login failed. Try again.";
            setMessage(message, "alert-danger");
          }
        );
      };

      vm.logout = function () {
        setMessage("");
        $http.post("/api/auth/logout").finally(function () {
          vm.user = null;
          vm.disconnectBazaar();
          setMessage("Logged out", "alert-secondary");
          if (vm.isBazaarPage) {
            window.location.href = "/";
          }
          if (vm.isAdminPage) {
            window.location.href = "/";
          }
        });
      };

      vm.fetchMe();
    });
})();
