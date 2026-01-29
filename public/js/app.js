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
      vm.isTrainingPage = path.indexOf("/training") === 0;
      vm.isCrimeSkillsPage = path.indexOf("/crime-skills") === 0;
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
      vm.training = { loading: false, empty: false };
      vm.crimeSkills = { loading: false, empty: false, series: [] };
      vm.theme = {
        mode: "auto",
        applied: "light",
        buttonLabel: "Theme: Auto",
      };
      vm.themeTimer = null;
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

      function getStoredCoords() {
        try {
          var raw = localStorage.getItem("themeCoords");
          if (!raw) {
            return null;
          }
          var data = JSON.parse(raw);
          if (!data || !Number.isFinite(data.lat) || !Number.isFinite(data.lon)) {
            return null;
          }
          if (Date.now() - data.ts > 7 * 24 * 60 * 60 * 1000) {
            return null;
          }
          return data;
        } catch (err) {
          return null;
        }
      }

      function storeCoords(lat, lon) {
        try {
          localStorage.setItem(
            "themeCoords",
            JSON.stringify({ lat: lat, lon: lon, ts: Date.now() })
          );
        } catch (err) {}
      }

      function getCoords() {
        return new Promise(function (resolve, reject) {
          var stored = getStoredCoords();
          if (stored) {
            resolve(stored);
            return;
          }
          if (!navigator.geolocation) {
            reject(new Error("Geolocation unavailable"));
            return;
          }
          navigator.geolocation.getCurrentPosition(
            function (pos) {
              var lat = pos.coords.latitude;
              var lon = pos.coords.longitude;
              storeCoords(lat, lon);
              resolve({ lat: lat, lon: lon });
            },
            function () {
              reject(new Error("Geolocation denied"));
            },
            { timeout: 6000 }
          );
        });
      }

      function getSunTimes(date, lat, lon) {
        var rad = Math.PI / 180;
        var dayMs = 86400000;
        var J1970 = 2440588;
        var J2000 = 2451545;

        function toJulian(d) {
          return d.valueOf() / dayMs - 0.5 + J1970;
        }
        function fromJulian(j) {
          return new Date((j + 0.5 - J1970) * dayMs);
        }
        function toDays(d) {
          return toJulian(d) - J2000;
        }

        var e = rad * 23.4397;
        function rightAscension(l, b) {
          return Math.atan2(
            Math.sin(l) * Math.cos(e) - Math.tan(b) * Math.sin(e),
            Math.cos(l)
          );
        }
        function declination(l, b) {
          return Math.asin(
            Math.sin(b) * Math.cos(e) + Math.cos(b) * Math.sin(e) * Math.sin(l)
          );
        }
        function solarMeanAnomaly(d) {
          return rad * (357.5291 + 0.98560028 * d);
        }
        function eclipticLongitude(M) {
          var C =
            rad *
            (1.9148 * Math.sin(M) +
              0.02 * Math.sin(2 * M) +
              0.0003 * Math.sin(3 * M));
          var P = rad * 102.9372;
          return M + C + P + Math.PI;
        }
        function julianCycle(d, lw) {
          return Math.round(d - 0.0009 - lw / (2 * Math.PI));
        }
        function approxTransit(Ht, lw, n) {
          return 0.0009 + (Ht + lw) / (2 * Math.PI) + n;
        }
        function solarTransitJ(ds, M, L) {
          return J2000 + ds + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);
        }
        function hourAngle(h, phi, d) {
          return Math.acos(
            (Math.sin(h) - Math.sin(phi) * Math.sin(d)) /
              (Math.cos(phi) * Math.cos(d))
          );
        }
        function getSetJ(h, lw, phi, dec, n, M, L) {
          var w = hourAngle(h, phi, dec);
          var a = approxTransit(w, lw, n);
          return solarTransitJ(a, M, L);
        }

        var lw = rad * -lon;
        var phi = rad * lat;
        var d = toDays(date);
        var n = julianCycle(d, lw);
        var ds = approxTransit(0, lw, n);
        var M = solarMeanAnomaly(ds);
        var L = eclipticLongitude(M);
        var dec = declination(L, 0);
        var Jnoon = solarTransitJ(ds, M, L);
        var h0 = rad * -0.833;
        var Jset = getSetJ(h0, lw, phi, dec, n, M, L);
        var Jrise = Jnoon - (Jset - Jnoon);

        return {
          sunrise: fromJulian(Jrise),
          sunset: fromJulian(Jset),
        };
      }

      function fallbackSunTimes(date) {
        var sunrise = new Date(date);
        sunrise.setHours(6, 0, 0, 0);
        var sunset = new Date(date);
        sunset.setHours(18, 0, 0, 0);
        return { sunrise: sunrise, sunset: sunset };
      }

      function updateThemeLabel() {
        var modeLabel =
          vm.theme.mode === "auto"
            ? "Auto"
            : vm.theme.mode === "light"
            ? "Light"
            : "Dark";
        if (vm.theme.mode === "auto") {
          var applied = vm.theme.applied === "dark" ? "Dark" : "Light";
          vm.theme.buttonLabel = "Theme: " + modeLabel + " (" + applied + ")";
        } else {
          vm.theme.buttonLabel = "Theme: " + modeLabel;
        }
      }

      function applyThemeClass(mode) {
        var body = document.body;
        body.classList.remove("theme-light", "theme-dark");
        body.classList.add(mode === "dark" ? "theme-dark" : "theme-light");
        applyAsync(function () {
          vm.theme.applied = mode;
          updateThemeLabel();
        });
      }

      function scheduleThemeRefresh() {
        if (vm.themeTimer) {
          $timeout.cancel(vm.themeTimer);
        }
        vm.themeTimer = $timeout(function () {
          if (vm.theme.mode === "auto") {
            applyThemeMode();
          }
        }, 10 * 60 * 1000);
      }

      function applyThemeMode() {
        if (vm.theme.mode === "light") {
          applyThemeClass("light");
          return;
        }
        if (vm.theme.mode === "dark") {
          applyThemeClass("dark");
          return;
        }

        var now = new Date();
        getCoords()
          .then(function (coords) {
            var times = getSunTimes(now, coords.lat, coords.lon);
            var isDay = now >= times.sunrise && now < times.sunset;
            applyThemeClass(isDay ? "light" : "dark");
            scheduleThemeRefresh();
          })
          .catch(function () {
            var fallback = fallbackSunTimes(now);
            var isDay = now >= fallback.sunrise && now < fallback.sunset;
            applyThemeClass(isDay ? "light" : "dark");
            scheduleThemeRefresh();
          });
      }

      vm.cycleTheme = function () {
        var order = ["auto", "light", "dark"];
        var currentIndex = order.indexOf(vm.theme.mode);
        var next = order[(currentIndex + 1) % order.length];
        vm.theme.mode = next;
        try {
          localStorage.setItem("themeMode", next);
        } catch (err) {}
        applyThemeMode();
      };

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

      function iterateCursor(cursorPromise, onValue) {
        return cursorPromise.then(function loop(cursor) {
          if (!cursor) {
            return;
          }
          onValue(cursor.value);
          return cursor.continue().then(loop);
        });
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
          if (!window.idb || typeof window.idb.openDB !== "function") {
            reject(new Error("idb library is not loaded"));
            return;
          }
          window.idb
            .openDB("logs", 3, {
              upgrade: function (db) {
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
              },
            })
            .then(resolve)
            .catch(function (err) {
              reject(err || new Error("Failed to open IndexedDB"));
            });
        });
        return vm.logsDbPromise;
      }

      function deleteLogsDb() {
        return new Promise(function (resolve, reject) {
          if (!window.indexedDB) {
            reject(new Error("IndexedDB is not supported"));
            return;
          }
          if (!window.idb || typeof window.idb.deleteDB !== "function") {
            reject(new Error("idb library is not loaded"));
            return;
          }
          if (vm.logsDbPromise) {
            vm.logsDbPromise.then(function (db) {
              db.close();
            });
            vm.logsDbPromise = null;
          }
          window.idb
            .deleteDB("logs", {
              blocked: function () {
                reject(new Error("Logs DB delete is blocked"));
              },
            })
            .then(resolve)
            .catch(function (err) {
              reject(err || new Error("Failed to delete logs DB"));
            });
        });
      }

      function clearLogsStore() {
        return openLogsDb()
          .then(function (db) {
            var tx = db.transaction("logs", "readwrite");
            tx.store.clear();
            return tx.done;
          })
          .catch(function (err) {
            throw err || new Error("Failed to clear logs store");
          });
      }

      function addLogsBatch(entries) {
        if (!Array.isArray(entries) || entries.length === 0) {
          return Promise.resolve();
        }
        return openLogsDb()
          .then(function (db) {
            var tx = db.transaction("logs", "readwrite");
            var store = tx.store;
            entries.forEach(function (entry) {
              if (entry && typeof entry === "object") {
                store.add(entry);
              }
            });
            return tx.done;
          })
          .catch(function (err) {
            throw err || new Error("Failed to write log batch");
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
          .attr("class", "crime-grid crime-grid-x")
          .attr("transform", "translate(0," + (height - margin.bottom) + ")")
          .call(
            d3
              .axisBottom(x)
              .ticks(5)
              .tickSize(-(height - margin.top - margin.bottom))
              .tickFormat("")
          )
          .call(function (g) {
            g.selectAll(".tick line")
              .attr("stroke", "#272b34")
              .attr("stroke-opacity", 1);
            g.select(".domain").remove();
          });

        svg
          .append("g")
          .attr("class", "crime-grid crime-grid-y")
          .attr("transform", "translate(" + margin.left + ",0)")
          .call(
            d3
              .axisLeft(y)
              .ticks(4)
              .tickSize(-(width - margin.left - margin.right))
              .tickFormat("")
          )
          .call(function (g) {
            g.selectAll(".tick line")
              .attr("stroke", "#272b34")
              .attr("stroke-opacity", 1);
            g.select(".domain").remove();
          });

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
        if (action === "training") {
          window.location.href = "/training";
          return;
        }
        if (action === "crime-skills") {
          window.location.href = "/crime-skills";
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
        return openLogsDb()
          .then(function (db) {
            var tx = db.transaction("logs", "readonly");
            var store = tx.store;
            var index = store.index("log");
            var range = window.IDBKeyRange.only(logId);
            var counts = {};
            return iterateCursor(index.openCursor(range), function (entry) {
              var key = getDateKey(
                entry && entry.timestamp,
                granularity
              );
              if (key) {
                counts[key] = (counts[key] || 0) + 1;
              }
            })
              .then(function () {
                return tx.done;
              })
              .then(function () {
                return counts;
              });
          })
          .catch(function (err) {
            throw err || new Error("Failed to read revive logs");
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

      function fetchLogSeries(logId, valueKey) {
        function extractValue(entry) {
          var data = entry && entry.data;
          if (typeof data === "string") {
            try {
              data = JSON.parse(data);
            } catch (err) {
              data = null;
            }
          }
          var raw = data && typeof data === "object" ? data[valueKey] : null;
          if (raw == null && entry && Object.prototype.hasOwnProperty.call(entry, valueKey)) {
            raw = entry[valueKey];
          }
          if (
            raw == null &&
            data &&
            typeof data === "object" &&
            data.stats &&
            Object.prototype.hasOwnProperty.call(data.stats, valueKey)
          ) {
            raw = data.stats[valueKey];
          }
          if (typeof raw === "string") {
            raw = raw.replace(/,/g, "");
          }
          return Number(raw);
        }

        function extractLogId(entry) {
          if (!entry || typeof entry !== "object") {
            return null;
          }
          if (entry.log != null) {
            return entry.log;
          }
          if (entry.logId != null) {
            return entry.logId;
          }
          if (entry.log_id != null) {
            return entry.log_id;
          }
          var data = entry.data;
          if (typeof data === "string") {
            try {
              data = JSON.parse(data);
            } catch (err) {
              data = null;
            }
          }
          if (data && typeof data === "object") {
            if (data.log != null) {
              return data.log;
            }
            if (data.logId != null) {
              return data.logId;
            }
            if (data.log_id != null) {
              return data.log_id;
            }
          }
          return null;
        }

        function runQuery(db, key) {
          var tx = db.transaction("logs", "readonly");
          var store = tx.store;
          var index = store.index("log");
          var range = window.IDBKeyRange.only(key);
          var points = [];
          return iterateCursor(index.openCursor(range), function (entry) {
            var value = extractValue(entry);
            var ts = entry && entry.timestamp;
            if (Number.isFinite(value) && Number.isFinite(Number(ts))) {
              var seconds = Number(ts);
              if (seconds > 1e12) {
                seconds = Math.floor(seconds / 1000);
              }
              var date = new Date(seconds * 1000);
              if (!Number.isNaN(date.getTime())) {
                points.push({ date: date, value: value });
              }
            }
          })
            .then(function () {
              return tx.done;
            })
            .then(function () {
              return points;
            })
            .catch(function (err) {
              throw err || new Error("Failed to read training logs");
            });
        }

        function runScan(db) {
          var tx = db.transaction("logs", "readonly");
          var store = tx.store;
          var points = [];
          return iterateCursor(store.openCursor(), function (entry) {
            var entryLog = extractLogId(entry);
            if (String(entryLog) === String(logId)) {
              var value = extractValue(entry);
              var ts = entry && entry.timestamp;
              if (Number.isFinite(value) && Number.isFinite(Number(ts))) {
                var seconds = Number(ts);
                if (seconds > 1e12) {
                  seconds = Math.floor(seconds / 1000);
                }
                var date = new Date(seconds * 1000);
                if (!Number.isNaN(date.getTime())) {
                  points.push({ date: date, value: value });
                }
              }
            }
          })
            .then(function () {
              return tx.done;
            })
            .then(function () {
              return points;
            })
            .catch(function (err) {
              throw err || new Error("Failed to scan training logs");
            });
        }

        return openLogsDb().then(function (db) {
          return Promise.all([
            runQuery(db, logId),
            runQuery(db, String(logId)),
          ]).then(function (results) {
            var combined = results[0].concat(results[1]);
            if (!combined.length) {
              return runScan(db);
            }
            var seen = {};
            var unique = [];
            combined.forEach(function (point) {
              var key = point.date.getTime() + ":" + point.value;
              if (!seen[key]) {
                seen[key] = true;
                unique.push(point);
              }
            });
            unique.sort(function (a, b) {
              return a.date - b.date;
            });
            return unique;
          });
        });
      }

      function fetchCrimeSkillsSeries(logId) {
        function parseData(entry) {
          var data = entry && entry.data;
          if (typeof data === "string") {
            try {
              data = JSON.parse(data);
            } catch (err) {
              data = null;
            }
          }
          return data && typeof data === "object" ? data : null;
        }

        function extractLogId(entry) {
          if (!entry || typeof entry !== "object") {
            return null;
          }
          if (entry.log != null) {
            return entry.log;
          }
          if (entry.logId != null) {
            return entry.logId;
          }
          if (entry.log_id != null) {
            return entry.log_id;
          }
          var data = parseData(entry);
          if (data) {
            if (data.log != null) {
              return data.log;
            }
            if (data.logId != null) {
              return data.logId;
            }
            if (data.log_id != null) {
              return data.log_id;
            }
          }
          return null;
        }

        function buildPoint(entry) {
          var data = parseData(entry);
          var crime = data && data.crime ? String(data.crime) : null;
          var skillRaw =
            data && Object.prototype.hasOwnProperty.call(data, "skill_level")
              ? data.skill_level
              : entry && Object.prototype.hasOwnProperty.call(entry, "skill_level")
              ? entry.skill_level
              : null;
          if (crime) {
            crime = crime.trim();
          }
          if (!crime) {
            return null;
          }
          if (typeof skillRaw === "string") {
            skillRaw = skillRaw.replace(/,/g, "");
          }
          var skill = Number(skillRaw);
          if (!Number.isFinite(skill)) {
            return null;
          }
          var ts = entry && entry.timestamp;
          if (!Number.isFinite(Number(ts))) {
            return null;
          }
          var seconds = Number(ts);
          if (seconds > 1e12) {
            seconds = Math.floor(seconds / 1000);
          }
          var date = new Date(seconds * 1000);
          if (Number.isNaN(date.getTime())) {
            return null;
          }
          return { crime: crime, date: date, value: skill, ts: seconds };
        }

        function runQuery(db, key) {
          var tx = db.transaction("logs", "readonly");
          var store = tx.store;
          var index = store.index("log");
          var range = window.IDBKeyRange.only(key);
          var points = [];
          return iterateCursor(index.openCursor(range), function (entry) {
            var point = buildPoint(entry);
            if (point) {
              points.push(point);
            }
          })
            .then(function () {
              return tx.done;
            })
            .then(function () {
              return points;
            })
            .catch(function (err) {
              throw err || new Error("Failed to read crime skills logs");
            });
        }

        function runScan(db) {
          var tx = db.transaction("logs", "readonly");
          var store = tx.store;
          var points = [];
          return iterateCursor(store.openCursor(), function (entry) {
            var entryLog = extractLogId(entry);
            if (String(entryLog) === String(logId)) {
              var point = buildPoint(entry);
              if (point) {
                points.push(point);
              }
            }
          })
            .then(function () {
              return tx.done;
            })
            .then(function () {
              return points;
            })
            .catch(function (err) {
              throw err || new Error("Failed to scan crime skills logs");
            });
        }

        function dedupe(points) {
          var seen = {};
          var unique = [];
          points.forEach(function (point) {
            var key = point.ts + ":" + point.crime + ":" + point.value;
            if (!seen[key]) {
              seen[key] = true;
              unique.push(point);
            }
          });
          return unique;
        }

        return openLogsDb().then(function (db) {
          return Promise.all([
            runQuery(db, logId),
            runQuery(db, String(logId)),
          ])
            .then(function (results) {
              var combined = results[0].concat(results[1]);
              if (!combined.length) {
                return runScan(db);
              }
              return combined;
            })
            .then(function (points) {
              var unique = dedupe(points);
              var grouped = {};
              unique.forEach(function (point) {
                if (!grouped[point.crime]) {
                  grouped[point.crime] = [];
                }
                grouped[point.crime].push({ date: point.date, value: point.value });
              });
              return Object.keys(grouped)
                .sort()
                .map(function (label) {
                  grouped[label].sort(function (a, b) {
                    return a.date - b.date;
                  });
                  return { label: label, points: grouped[label] };
                });
            });
        });
      }

      function drawTrainingChart(seriesList) {
        var container = document.getElementById("trainingChart");
        if (!container || !seriesList || !seriesList.length || !window.d3) {
          return;
        }
        var d3 = window.d3;
        d3.select(container).selectAll("*").remove();

        var width = container.clientWidth || 900;
        var height = container.clientHeight || 360;
        var margin = { top: 24, right: 24, bottom: 44, left: 60 };

        var allPoints = [];
        seriesList.forEach(function (series) {
          series.points.forEach(function (point) {
            allPoints.push(point);
          });
        });
        if (!allPoints.length) {
          return;
        }

        var xExtent = d3.extent(allPoints, function (d) {
          return d.date;
        });
        var xPadding = 0;
        if (xExtent[0] && xExtent[1]) {
          var span = xExtent[1].getTime() - xExtent[0].getTime();
          xPadding = span * 0.1;
        }
        var x = d3
          .scaleTime()
          .domain([
            xExtent[0],
            xExtent[1] ? new Date(xExtent[1].getTime() + xPadding) : xExtent[1],
          ])
          .range([margin.left, width - margin.right]);

        var y = d3
          .scaleLinear()
          .domain(d3.extent(allPoints, function (d) {
            return d.value;
          }))
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
          tooltip.style("opacity", 1).text(text);
          var bounds = container.getBoundingClientRect();
          var xPos = event.clientX - bounds.left + 12;
          var yPos = event.clientY - bounds.top - 24;
          tooltip.style("left", xPos + "px").style("top", yPos + "px");
        }

        function hideTooltip() {
          tooltip.style("opacity", 0);
        }

        svg
          .append("g")
          .attr("transform", "translate(0," + (height - margin.bottom) + ")")
          .call(
            d3
              .axisBottom(x)
              .ticks(5)
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

        seriesList.forEach(function (series) {
          if (!series.points.length) {
            return;
          }
          var seriesGroup = svg
            .append("g")
            .attr("class", "training-series")
            .attr("data-series", series.label);

          seriesGroup
            .append("path")
            .datum(series.points)
            .attr("fill", "none")
            .attr("stroke", series.color)
            .attr("stroke-width", 2)
            .attr("d", line);

          seriesGroup
            .selectAll("circle.training-point")
            .data(series.points)
            .enter()
            .append("circle")
            .attr("class", "training-point")
            .attr("data-series", series.label)
            .attr("cx", function (d) {
              return x(d.date);
            })
            .attr("cy", function (d) {
              return y(d.value);
            })
            .attr("r", 3)
            .attr("fill", series.color)
            .on("mousemove", function (event, d) {
              showTooltip(event, "Value: " + d.value);
            })
            .on("mouseleave", hideTooltip);
        });
      }

      function drawCrimeSkillsChart(seriesList) {
        var container = document.getElementById("crimeSkillsChart");
        if (!container || !seriesList || !seriesList.length || !window.d3) {
          return;
        }
        var d3 = window.d3;
        d3.select(container).selectAll("*").remove();

        var width = container.clientWidth || 900;
        var height = container.clientHeight || 360;
        var margin = { top: 24, right: 24, bottom: 44, left: 60 };

        var allPoints = [];
        seriesList.forEach(function (series) {
          series.points.forEach(function (point) {
            allPoints.push(point);
          });
        });
        if (!allPoints.length) {
          return;
        }

        var xExtent = d3.extent(allPoints, function (d) {
          return d.date;
        });
        var xPadding = 0;
        if (xExtent[0] && xExtent[1]) {
          var span = xExtent[1].getTime() - xExtent[0].getTime();
          xPadding = span * 0.1;
        }
        var x = d3
          .scaleTime()
          .domain([
            xExtent[0],
            xExtent[1] ? new Date(xExtent[1].getTime() + xPadding) : xExtent[1],
          ])
          .range([margin.left, width - margin.right]);

        var y = d3
          .scaleLinear()
          .domain(d3.extent(allPoints, function (d) {
            return d.value;
          }))
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
          tooltip.style("opacity", 1).text(text);
          var bounds = container.getBoundingClientRect();
          var xPos = event.clientX - bounds.left + 12;
          var yPos = event.clientY - bounds.top - 24;
          tooltip.style("left", xPos + "px").style("top", yPos + "px");
        }

        function hideTooltip() {
          tooltip.style("opacity", 0);
        }

        svg
          .append("g")
          .attr("transform", "translate(0," + (height - margin.bottom) + ")")
          .call(
            d3
              .axisBottom(x)
              .ticks(5)
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

        seriesList.forEach(function (series) {
          if (!series.points.length) {
            return;
          }
          var seriesGroup = svg
            .append("g")
            .attr("class", "crime-skill-series")
            .attr("data-series", series.label);

          seriesGroup
            .append("path")
            .datum(series.points)
            .attr("fill", "none")
            .attr("stroke", series.color)
            .attr("stroke-width", 2)
            .attr("d", line);

          seriesGroup
            .selectAll("circle.crime-skill-point")
            .data(series.points)
            .enter()
            .append("circle")
            .attr("class", "crime-skill-point")
            .attr("data-series", series.label)
            .attr("cx", function (d) {
              return x(d.date);
            })
            .attr("cy", function (d) {
              return y(d.value);
            })
            .attr("r", 3)
            .attr("fill", series.color)
            .on("mousemove", function (event, d) {
              showTooltip(event, series.label + ": " + d.value);
            })
            .on("mouseleave", hideTooltip);
        });
      }

      vm.loadTraining = function () {
        if (!vm.user) {
          return;
        }
        if (!vm.isTrainingPage) {
          return;
        }
        applyAsync(function () {
          vm.training.loading = true;
          vm.training.empty = false;
        });
        Promise.all([
          fetchLogSeries(5302, "speed_after"),
          fetchLogSeries(5301, "defense_after"),
          fetchLogSeries(5303, "dexterity_after"),
          fetchLogSeries(5300, "strength_after"),
        ])
          .then(function (seriesResults) {
            var seriesList = [
              { label: "5302 speed", color: "#facc15", points: seriesResults[0] || [] },
              { label: "5301 defense (green)", color: "#22c55e", points: seriesResults[1] || [] },
              { label: "5303 dexterity", color: "#3b82f6", points: seriesResults[2] || [] },
              { label: "5300 strength", color: "#ef4444", points: seriesResults[3] || [] },
            ];
            var hasData = seriesList.some(function (series) {
              return series.points.length;
            });
            applyAsync(function () {
              vm.training.loading = false;
              vm.training.empty = !hasData;
            });
            try {
              console.debug("Training series data", JSON.stringify(seriesList));
            } catch (err) {
              console.debug("Training series data (raw)", seriesList);
            }
            $timeout(function () {
              drawTrainingChart(seriesList);
            }, 0);
          })
          .catch(function () {
            applyAsync(function () {
              vm.training.loading = false;
              vm.training.empty = true;
            });
          });
      };

      vm.loadCrimeSkills = function () {
        if (!vm.user) {
          return;
        }
        if (!vm.isCrimeSkillsPage) {
          return;
        }
        applyAsync(function () {
          vm.crimeSkills.loading = true;
          vm.crimeSkills.empty = false;
        });
        fetchCrimeSkillsSeries(9005)
          .then(function (seriesList) {
            var palette = [
              "#f97316",
              "#22c55e",
              "#3b82f6",
              "#ef4444",
              "#a855f7",
              "#14b8a6",
              "#facc15",
              "#ec4899",
              "#84cc16",
              "#0ea5e9",
            ];
            var colored = (seriesList || []).map(function (series, index) {
              return {
                label: series.label,
                points: series.points || [],
                color: palette[index % palette.length],
              };
            });
            var hasData = colored.some(function (series) {
              return series.points.length;
            });
            applyAsync(function () {
              vm.crimeSkills.loading = false;
              vm.crimeSkills.empty = !hasData;
              vm.crimeSkills.series = colored;
            });
            $timeout(function () {
              drawCrimeSkillsChart(colored);
            }, 0);
          })
          .catch(function () {
            applyAsync(function () {
              vm.crimeSkills.loading = false;
              vm.crimeSkills.empty = true;
              vm.crimeSkills.series = [];
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
            if (vm.isTrainingPage) {
              vm.loadTraining();
            }
            if (vm.isCrimeSkillsPage) {
              vm.loadCrimeSkills();
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
          window.location.href = "/";
        });
      };

      try {
        var storedMode = localStorage.getItem("themeMode");
        if (storedMode === "auto" || storedMode === "light" || storedMode === "dark") {
          vm.theme.mode = storedMode;
        }
      } catch (err) {}
      applyThemeMode();
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
