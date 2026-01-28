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
      vm.isXanaxPage = path.indexOf("/xanax") === 0;
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
      vm.wsActivity = { items: false, prices: false };
      vm.wsActivityTimers = { items: null, prices: null };
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
      vm.logsExpectedTotal = null;
      vm.toast = { show: false, message: "" };
      vm.toastTimer = null;
      vm.revives = {
        granularity: "daily",
        loading: false,
        empty: false,
        last30Only: false,
        last30Total: 0,
      };
      vm.xanax = {
        granularity: "daily",
        loading: false,
        empty: false,
        last30Only: false,
        last30Total: 0,
      };
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
        vm.logsExpectedTotal = null;
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
        var circulation = raw.circulation || raw.circ || raw.stock || null;
        return {
          id: typeof id === "string" ? Number(id) || id : id,
          name: name,
          description: description,
          img64: img64,
          type: type,
          circulation: circulation,
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

      vm.statusDotClass = function (status) {
        switch (status) {
          case "connected":
            return "ws-dot-green";
          case "connecting":
            return "ws-dot-orange";
          case "error":
            return "ws-dot-red";
          default:
            return "ws-dot-red";
        }
      };

      function flashActivity(key) {
        if (!vm.wsActivity.hasOwnProperty(key)) {
          return;
        }
        vm.wsActivity[key] = true;
        if (vm.wsActivityTimers[key]) {
          $timeout.cancel(vm.wsActivityTimers[key]);
        }
        vm.wsActivityTimers[key] = $timeout(function () {
          vm.wsActivity[key] = false;
        }, 600);
      }

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
        var container = document.getElementById("priceChart");
        if (!container || !points || !points.length || !window.d3) {
          return;
        }
        var d3 = window.d3;
        d3.select(container).selectAll("*").remove();

        var width = container.clientWidth || 760;
        var height = container.clientHeight || 360;
        var margin = { top: 24, right: 24, bottom: 44, left: 60 };

        function normalizeDate(value) {
          if (!value) {
            return null;
          }
          if (typeof value === "string" && /^\d{8}$/.test(value)) {
            var year = Number(value.slice(0, 4));
            var month = Number(value.slice(4, 6)) - 1;
            var day = Number(value.slice(6, 8));
            var compactDate = new Date(Date.UTC(year, month, day));
            return Number.isNaN(compactDate.getTime()) ? null : compactDate;
          }
          if (typeof value === "number") {
            var ms = value > 1e12 ? value : value * 1000;
            var dNum = new Date(ms);
            return Number.isNaN(dNum.getTime()) ? null : dNum;
          }
          var parsed = new Date(value);
          if (!Number.isNaN(parsed.getTime())) {
            return parsed;
          }
          var tryDate = d3.timeParse("%Y-%m-%d")(value);
          return tryDate || null;
        }

        var data = points
          .map(function (point) {
            return {
              date: normalizeDate(point.date),
              value: point.value,
            };
          })
          .filter(function (point) {
            return point.date && Number.isFinite(point.value);
          });
        if (!data.length) {
          return;
        }

        var x = d3
          .scaleTime()
          .domain(d3.extent(data, function (d) {
            return d.date;
          }))
          .range([margin.left, width - margin.right]);

        var min = d3.min(data, function (d) {
          return d.value;
        });
        var max = d3.max(data, function (d) {
          return d.value;
        });
        if (!Number.isFinite(min) || !Number.isFinite(max)) {
          return;
        }
        if (min === max) {
          min = min * 0.95;
          max = max * 1.05;
        }
        var y = d3
          .scaleLinear()
          .domain([min, max])
          .nice()
          .range([height - margin.bottom, margin.top]);

        var svg = d3
          .select(container)
          .append("svg")
          .attr("width", width)
          .attr("height", height);

        svg
          .append("g")
          .attr("transform", "translate(0," + (height - margin.bottom) + ")")
          .call(
            d3
              .axisBottom(x)
              .ticks(4)
              .tickFormat(d3.timeFormat("%Y-%m-%d"))
          )
          .selectAll("text")
          .style("font-size", "11px");

        svg
          .append("g")
          .attr("transform", "translate(" + margin.left + ",0)")
          .call(d3.axisLeft(y).ticks(4))
          .selectAll("text")
          .style("font-size", "11px");

        var line = d3
          .line()
          .x(function (d) {
            return x(d.date);
          })
          .y(function (d) {
            return y(d.value);
          });

        svg
          .append("path")
          .datum(data)
          .attr("fill", "none")
          .attr("stroke", "#0f766e")
          .attr("stroke-width", 2)
          .attr("d", line);

        svg
          .selectAll("circle")
          .data(data)
          .enter()
          .append("circle")
          .attr("cx", function (d) {
            return x(d.date);
          })
          .attr("cy", function (d) {
            return y(d.value);
          })
          .attr("r", 3)
          .attr("fill", "#0f766e");
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
          flashActivity("items");
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
            if (payload.phase === "end") {
              vm.logsLoading = false;
              vm.logsRequestId = null;
              showToast("Logs fetched: " + vm.logsReceivedCount);
              return;
            }
            if (payload.phase !== "batch") {
              return;
            }
            var sentCount = Number(payload.sent);
            var totalCount = Number(payload.total);
            if (Number.isFinite(totalCount) && totalCount > 0) {
              vm.logsExpectedTotal = totalCount;
            }
            var isDone =
              Number.isFinite(sentCount) &&
              Number.isFinite(totalCount) &&
              totalCount > 0 &&
              sentCount >= totalCount;
            var batchEntries = payload.batch || [];
            vm.logsReceivedCount += batchEntries.length;
            addLogsBatch(batchEntries)
              .then(function () {
                if (
                  isDone ||
                  (Number.isFinite(vm.logsExpectedTotal) &&
                    vm.logsReceivedCount >= vm.logsExpectedTotal)
                ) {
                  vm.logsLoading = false;
                  vm.logsRequestId = null;
                  showToast("Logs fetched: " + vm.logsReceivedCount);
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
          flashActivity("prices");
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
        if (action === "xanax") {
          window.location.href = "/xanax";
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
        var container = document.getElementById("revivesChart");
        if (!container || !points || !points.length || !window.d3) {
          return;
        }
        var d3 = window.d3;
        d3.select(container).selectAll("*").remove();

        var width = container.clientWidth || 900;
        var height = container.clientHeight || 360;
        var margin = { top: 24, right: 24, bottom: 44, left: 60 };

        var data = points
          .map(function (point) {
            return {
              date: point.date,
              value: Number(point.value || 0),
              valueAlt: Number(point.valueAlt || 0),
            };
          })
          .filter(function (point) {
            return point && point.date;
          });
        if (!data.length) {
          return;
        }

        data.sort(function (a, b) {
          return a.date.localeCompare(b.date);
        });
        var labels = data.map(function (point) {
          return point.date;
        });
        var x = d3
          .scaleBand()
          .domain(labels)
          .range([margin.left, width - margin.right])
          .padding(0.2);

        var maxCount = d3.max(data, function (d) {
          return Math.max(d.value, d.valueAlt);
        });
        if (!Number.isFinite(maxCount) || maxCount === 0) {
          maxCount = 1;
        }
        var cumulative = [];
        var runningTotal = 0;
        data.forEach(function (point) {
          runningTotal += point.value;
          cumulative.push({ date: point.date, total: runningTotal });
        });
        var maxTotal = d3.max(cumulative, function (d) {
          return d.total;
        });
        if (!Number.isFinite(maxTotal) || maxTotal === 0) {
          maxTotal = 1;
        }

        var y = d3
          .scaleLinear()
          .domain([0, maxCount])
          .nice()
          .range([height - margin.bottom, margin.top]);

        var yTotal = d3
          .scaleLinear()
          .domain([0, maxTotal])
          .nice()
          .range([height - margin.bottom, margin.top]);

        var svg = d3
          .select(container)
          .append("svg")
          .attr("width", width)
          .attr("height", height);

        var tooltip = d3
          .select(container)
          .append("div")
          .attr("class", "chart-tooltip")
          .style("opacity", 0);

        function showTooltip(event, text) {
          tooltip
            .style("opacity", 1)
            .text(text);
          var bounds = container.getBoundingClientRect();
          var xPos = event.clientX - bounds.left + 12;
          var yPos = event.clientY - bounds.top - 24;
          tooltip
            .style("left", xPos + "px")
            .style("top", yPos + "px");
        }

        function hideTooltip() {
          tooltip.style("opacity", 0);
        }

        var step = Math.ceil(labels.length / 6);
        var tickValues = labels.filter(function (_, index) {
          return index % step === 0;
        });

        svg
          .append("g")
          .attr("transform", "translate(0," + (height - margin.bottom) + ")")
          .call(d3.axisBottom(x).tickValues(tickValues))
          .selectAll("text")
          .style("font-size", "11px");

        svg
          .append("g")
          .attr("transform", "translate(" + margin.left + ",0)")
          .call(d3.axisLeft(y).ticks(4))
          .selectAll("text")
          .style("font-size", "11px");

        svg
          .append("g")
          .attr("transform", "translate(" + (width - margin.right) + ",0)")
          .call(d3.axisRight(yTotal).ticks(4))
          .selectAll("text")
          .style("font-size", "11px");

        var series = ["success", "failure"];
        var x1 = d3
          .scaleBand()
          .domain(series)
          .range([0, x.bandwidth()])
          .padding(0.2);

        var group = svg
          .append("g")
          .selectAll("g")
          .data(data)
          .enter()
          .append("g")
          .attr("transform", function (d) {
            return "translate(" + x(d.date) + ",0)";
          });

        group
          .append("rect")
          .attr("x", x1("success"))
          .attr("y", function (d) {
            return y(d.value);
          })
          .attr("height", function (d) {
            return y(0) - y(d.value);
          })
          .attr("width", x1.bandwidth())
          .attr("fill", "#2563eb")
          .on("mousemove", function (event, d) {
            showTooltip(event, "Successes: " + d.value);
          })
          .on("mouseleave", hideTooltip);

        group
          .append("rect")
          .attr("x", x1("failure"))
          .attr("y", function (d) {
            return y(d.valueAlt);
          })
          .attr("height", function (d) {
            return y(0) - y(d.valueAlt);
          })
          .attr("width", x1.bandwidth())
          .attr("fill", "#ef4444")
          .on("mousemove", function (event, d) {
            showTooltip(event, "Failures: " + d.valueAlt);
          })
          .on("mouseleave", hideTooltip);

        var line = d3
          .line()
          .x(function (d) {
            return x(d.date) + x.bandwidth() / 2;
          })
          .y(function (d) {
            return yTotal(d.total);
          });

        svg
          .append("path")
          .datum(cumulative)
          .attr("fill", "none")
          .attr("stroke", "#f97316")
          .attr("stroke-width", 2)
          .attr("d", line);

        svg
          .selectAll("circle")
          .data(cumulative)
          .enter()
          .append("circle")
          .attr("cx", function (d) {
            return x(d.date) + x.bandwidth() / 2;
          })
          .attr("cy", function (d) {
            return yTotal(d.total);
          })
          .attr("r", 3)
          .attr("fill", "#f97316")
          .on("mousemove", function (event, d) {
            showTooltip(event, "Total Successes: " + d.total);
          })
          .on("mouseleave", hideTooltip);
      }

      function fetchLogCounts(logId, granularity) {
        return openLogsDb().then(function (db) {
          return new Promise(function (resolve, reject) {
            var tx = db.transaction("logs", "readonly");
            var store = tx.objectStore("logs");
            var index = store.index("log");
            var range = window.IDBKeyRange.only(logId);
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
                granularity
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
        });
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
        Promise.all([
          fetchLogCounts(5410, vm.revives.granularity),
          fetchLogCounts(5415, vm.revives.granularity),
        ])
          .then(function (results) {
            var countsA = results[0] || {};
            var countsB = results[1] || {};
            var keyMap = {};
            Object.keys(countsA).forEach(function (key) {
              keyMap[key] = true;
            });
            Object.keys(countsB).forEach(function (key) {
              keyMap[key] = true;
            });
            var keys = Object.keys(keyMap).sort();
            var points = keys.map(function (key) {
              return {
                date: key,
                value: countsA[key] || 0,
                valueAlt: countsB[key] || 0,
              };
            });
            var filteredPoints = points;
            var total30 = 0;
            if (vm.revives.last30Only) {
              var now = new Date();
              var cutoff = new Date(
                Date.UTC(
                  now.getUTCFullYear(),
                  now.getUTCMonth(),
                  now.getUTCDate() - 29
                )
              );
              filteredPoints = points.filter(function (point) {
                var parsed = new Date(point.date + "T00:00:00Z");
                if (Number.isNaN(parsed.getTime())) {
                  return false;
                }
                return parsed >= cutoff;
              });
              filteredPoints.forEach(function (point) {
                total30 += point.value + point.valueAlt;
              });
            }
            var empty =
              filteredPoints.length === 0 ||
              filteredPoints.every(function (point) {
                return point.value === 0 && point.valueAlt === 0;
              });
            applyAsync(function () {
              vm.revives.loading = false;
              vm.revives.empty = empty;
              vm.revives.last30Total = total30;
            });
            $timeout(function () {
              drawRevivesChart(filteredPoints);
            }, 0);
          })
          .catch(function () {
            applyAsync(function () {
              vm.revives.loading = false;
              vm.revives.empty = true;
              vm.revives.last30Total = 0;
            });
          });
      };

      vm.loadXanax = function (granularity) {
        if (!vm.user) {
          return;
        }
        if (!vm.isXanaxPage) {
          return;
        }
        applyAsync(function () {
          vm.xanax.loading = true;
          vm.xanax.empty = false;
        });
        if (granularity) {
          vm.xanax.granularity = granularity;
        }
        Promise.all([
          fetchLogCounts(2290, vm.xanax.granularity),
          fetchLogCounts(2291, vm.xanax.granularity),
        ])
          .then(function (results) {
            var countsA = results[0] || {};
            var countsB = results[1] || {};
            var keyMap = {};
            Object.keys(countsA).forEach(function (key) {
              keyMap[key] = true;
            });
            Object.keys(countsB).forEach(function (key) {
              keyMap[key] = true;
            });
            var keys = Object.keys(keyMap).sort();
            var points = keys.map(function (key) {
              return {
                date: key,
                value: countsA[key] || 0,
                valueAlt: countsB[key] || 0,
              };
            });
            var filteredPoints = points;
            var total30 = 0;
            if (vm.xanax.last30Only) {
              var now = new Date();
              var cutoff = new Date(
                Date.UTC(
                  now.getUTCFullYear(),
                  now.getUTCMonth(),
                  now.getUTCDate() - 29
                )
              );
              filteredPoints = points.filter(function (point) {
                var parsed = new Date(point.date + "T00:00:00Z");
                if (Number.isNaN(parsed.getTime())) {
                  return false;
                }
                return parsed >= cutoff;
              });
              filteredPoints.forEach(function (point) {
                total30 += point.value + point.valueAlt;
              });
            }
            var empty =
              filteredPoints.length === 0 ||
              filteredPoints.every(function (point) {
                return point.value === 0 && point.valueAlt === 0;
              });
            applyAsync(function () {
              vm.xanax.loading = false;
              vm.xanax.empty = empty;
              vm.xanax.last30Total = total30;
            });
            $timeout(function () {
              drawXanaxChart(filteredPoints);
            }, 0);
          })
          .catch(function () {
            applyAsync(function () {
              vm.xanax.loading = false;
              vm.xanax.empty = true;
              vm.xanax.last30Total = 0;
            });
          });
      };

      vm.toggleXanaxLast30 = function () {
        vm.xanax.last30Only = !vm.xanax.last30Only;
        if (vm.isXanaxPage) {
          vm.loadXanax(vm.xanax.granularity);
        }
      };

      vm.toggleLast30 = function () {
        vm.revives.last30Only = !vm.revives.last30Only;
        if (vm.isRevivesPage) {
          vm.loadRevives(vm.revives.granularity);
        }
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
            if (vm.isXanaxPage) {
              vm.loadXanax(vm.xanax.granularity);
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
      function drawXanaxChart(points) {
        var container = document.getElementById("xanaxChart");
        if (!container || !points || !points.length || !window.d3) {
          return;
        }
        var d3 = window.d3;
        d3.select(container).selectAll("*").remove();

        var width = container.clientWidth || 900;
        var height = container.clientHeight || 360;
        var margin = { top: 24, right: 24, bottom: 44, left: 60 };

        var data = points
          .map(function (point) {
            return {
              date: point.date,
              value: Number(point.value || 0),
              valueAlt: Number(point.valueAlt || 0),
            };
          })
          .filter(function (point) {
            return point && point.date;
          });
        if (!data.length) {
          return;
        }

        data.sort(function (a, b) {
          return a.date.localeCompare(b.date);
        });
        var labels = data.map(function (point) {
          return point.date;
        });
        var x = d3
          .scaleBand()
          .domain(labels)
          .range([margin.left, width - margin.right])
          .padding(0.2);

        var maxCount = d3.max(data, function (d) {
          return Math.max(d.value, d.valueAlt);
        });
        if (!Number.isFinite(maxCount) || maxCount === 0) {
          maxCount = 1;
        }
        var y = d3
          .scaleLinear()
          .domain([0, maxCount])
          .nice()
          .range([height - margin.bottom, margin.top]);

        var svg = d3
          .select(container)
          .append("svg")
          .attr("width", width)
          .attr("height", height);

        var step = Math.ceil(labels.length / 6);
        var tickValues = labels.filter(function (_, index) {
          return index % step === 0;
        });

        svg
          .append("g")
          .attr("transform", "translate(0," + (height - margin.bottom) + ")")
          .call(d3.axisBottom(x).tickValues(tickValues))
          .selectAll("text")
          .style("font-size", "11px");

        svg
          .append("g")
          .attr("transform", "translate(" + margin.left + ",0)")
          .call(d3.axisLeft(y).ticks(4))
          .selectAll("text")
          .style("font-size", "11px");

        var series = ["2290", "2291"];
        var x1 = d3
          .scaleBand()
          .domain(series)
          .range([0, x.bandwidth()])
          .padding(0.2);

        var group = svg
          .append("g")
          .selectAll("g")
          .data(data)
          .enter()
          .append("g")
          .attr("transform", function (d) {
            return "translate(" + x(d.date) + ",0)";
          });

        group
          .append("rect")
          .attr("x", x1("2290"))
          .attr("y", function (d) {
            return y(d.value);
          })
          .attr("height", function (d) {
            return y(0) - y(d.value);
          })
          .attr("width", x1.bandwidth())
          .attr("fill", "#2563eb");

        group
          .append("rect")
          .attr("x", x1("2291"))
          .attr("y", function (d) {
            return y(d.valueAlt);
          })
          .attr("height", function (d) {
            return y(0) - y(d.valueAlt);
          })
          .attr("width", x1.bandwidth())
          .attr("fill", "#ef4444");
      }
