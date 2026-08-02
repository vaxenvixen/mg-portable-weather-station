// ==UserScript==
// @name         Magic Garden Weather Station
// @namespace    https://example.com/weather-station
// @version      1.0.0
// @description  Portaable weather station for Magic Garden
// @author       Vaxen
// @match        https://1227719606223765687.discordsays.com/*
// @match        https://magiccircle.gg/r/*
// @match        https://magicgarden.gg/r/*
// @match        https://starweaver.org/r/*
// @grant        GM_xmlhttpRequest
// @connect      raw.githubusercontent.com
// @updateURL    https://raw.githubusercontent.com/vaxenvixen/mg-portable-weather-station/main/mg-portable-weatherstation.user.js
// @downloadURL  https://raw.githubusercontent.com/vaxenvixen/mg-portable-weather-station/main/mg-portable-weatherstation.user.js
// @run-at       document-idle
// ==/UserScript==
"use strict";
(() => {
  const page = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
  const PANEL_ID = "weather-station";
  const SCRIPT_VERSION = "1.0.0";
  const VERSION_CHECK_URL = "https://raw.githubusercontent.com/vaxenvixen/mg-portable-weather-station/main/magic-garden-weather-station.user.js";
  const VERSION_CHECK_INTERVAL_MS = 30 * 60 * 1000;

  function getPanelManager() {
    if (!page.__mgPanelManager) {
      const panels = new Map();
      const manager = {
        register(id, panelEl, buttonEl, onClose) {
          panels.set(id, { panelEl, buttonEl, onClose });
        },
        closeAllExcept(exceptId) {
          for (const [id, entry] of panels) if (id !== exceptId) entry.onClose();
        },
        closeAll() {
          for (const [, entry] of panels) entry.onClose();
        }
      };
      document.addEventListener("click", (event) => {
        const clickedInsideAny = [...panels.values()].some(
          ({ panelEl, buttonEl }) => panelEl.contains(event.target) || buttonEl?.contains(event.target)
        );
        if (!clickedInsideAny) manager.closeAll();
      }, true);
      page.__mgPanelManager = manager;
    }
    return page.__mgPanelManager;
  }

  function subscribeToRoomPatches(handler, attempt = 0) {
    const connection = page.MagicCircle_RoomConnection;
    if (typeof connection?.subscribeToPatches !== "function") {
      if (attempt < 60) setTimeout(() => subscribeToRoomPatches(handler, attempt + 1), 1000);
      return;
    }
    if (!connection.__mgListeners) {
      connection.__mgListeners = [];
      connection.subscribeToPatches((patches, fullState) => {
        for (const listener of connection.__mgListeners) {
          try {
            listener(patches, fullState);
          } catch (err) {
            console.error("[Magic Garden scripts] listener error:", err);
          }
        }
      });
    }
    connection.__mgListeners.push(handler);
  }

  const SLOT_MINUTES = 5;
  const SLOT_MS = SLOT_MINUTES * 60 * 1000;
  const SLOTS_PER_DAY = 288;
  const LOOKAHEAD_DAYS = 2;

  const GROUP = { HYDRO: "Hydro", LUNAR: "Lunar" };

  const WEATHER_META = {
    Rain: { groupId: GROUP.HYDRO, label: "Rain", icon: "\uD83C\uDF27\uFE0F" },
    Frost: { groupId: GROUP.HYDRO, label: "Snow", icon: "\u2744\uFE0F" }, // internal id "Frost" displays as "Snow"
    Thunderstorm: { groupId: GROUP.HYDRO, label: "Thunderstorm", icon: "\u26A1" },
    Dawn: { groupId: GROUP.LUNAR, label: "Dawn", icon: "\uD83C\uDF05" },
    AmberMoon: { groupId: GROUP.LUNAR, label: "Amber Moon", icon: "\uD83C\uDF15" }
  };

  const GROUP_CONFIG = [
    {
      groupId: GROUP.HYDRO,
      durationMinutes: 10,
      randomTimeSlots: { minFrequencyMinutes: 40, maxFrequencyMinutes: 60 },
      dropTable: [
        { weatherId: "Rain", weight: 50 },
        { weatherId: "Frost", weight: 30 },
        { weatherId: "Thunderstorm", weight: 20 }
      ]
    },
    {
      groupId: GROUP.LUNAR,
      durationMinutes: 10,
      fixedTimeSlots: [0, 48, 96, 144, 192, 240], // every 4 hours
      dropTable: [
        { weatherId: "Dawn", weight: 67 },
        { weatherId: "AmberMoon", weight: 33 }
      ]
    }
  ];

  function startOfUtcDay(date) {
    const d = new Date(date);
    d.setUTCHours(0, 0, 0, 0);
    return d;
  }
  function dayKeyFor(date) {
    return new Date(date).toISOString().slice(0, 10);
  }
  function addDays(date, days) {
    return new Date(date.getTime() + days * 86400000);
  }
  function slotIndexFor(date) {
    return Math.floor((date.getTime() - startOfUtcDay(date).getTime()) / SLOT_MS);
  }
  function slotToMs(dayRefDate, slotIndex) {
    return startOfUtcDay(dayRefDate).getTime() + slotIndex * SLOT_MS;
  }
  function slotSpan(durationMinutes) {
    return Math.floor(durationMinutes / SLOT_MINUTES);
  }

  // Public-domain "Mash" hash used to seed Alea (see file header).
  function createMash() {
    let n = 4022871197;
    return function (data) {
      data = String(data);
      for (let i = 0; i < data.length; i++) {
        n += data.charCodeAt(i);
        let h = 0.02519603282416938 * n;
        n = h >>> 0;
        h -= n;
        h *= n;
        n = h >>> 0;
        h -= n;
        n += h * 4294967296;
      }
      return (n >>> 0) * 2.3283064365386963e-10;
    };
  }

  function createAlea(seed) {
    const mash = createMash();
    let s0 = mash(" ");
    let s1 = mash(" ");
    let s2 = mash(" ");
    let carry = 1;
    s0 -= mash(seed);
    if (s0 < 0) s0 += 1;
    s1 -= mash(seed);
    if (s1 < 0) s1 += 1;
    s2 -= mash(seed);
    if (s2 < 0) s2 += 1;
    return function () {
      const t = 2091639 * s0 + carry * 2.3283064365386963e-10;
      s0 = s1;
      s1 = s2;
      carry = t | 0;
      s2 = t - carry;
      return s2;
    };
  }

  function weightedPick(entries, rng) {
    const total = entries.reduce((sum, e) => sum + (e.weight > 0 ? e.weight : 0), 0);
    if (total <= 0) return undefined;
    const roll = rng() * total;
    let acc = 0;
    for (const entry of entries) {
      if (entry.weight <= 0) continue;
      acc += entry.weight;
      if (roll <= acc) return entry;
    }
    return undefined;
  }

  function generateDaySchedule(dayKey) {
    const slots = {};
    const rng = createAlea(dayKey);
    const occupied = new Set();

    for (const group of GROUP_CONFIG) {
      if (!group.fixedTimeSlots) continue;
      const span = slotSpan(group.durationMinutes);
      for (const start of group.fixedTimeSlots)
        for (let i = 0; i < span; i++) occupied.add(start + i);
    }

    for (const group of GROUP_CONFIG) {
      if (!group.randomTimeSlots) continue;
      const { minFrequencyMinutes, maxFrequencyMinutes } = group.randomTimeSlots;
      const minSlots = Math.floor(minFrequencyMinutes / SLOT_MINUTES);
      const maxSlots = Math.floor(maxFrequencyMinutes / SLOT_MINUTES);
      const span = slotSpan(group.durationMinutes);
      let cursor = Math.floor(rng() * minSlots);
      while (cursor < SLOTS_PER_DAY) {
        const picked = weightedPick(group.dropTable, rng);
        let fits = cursor + span <= SLOTS_PER_DAY;
        for (let i = 0; fits && i < span; i++) if (occupied.has(cursor + i)) fits = false;
        if (fits) for (let i = 0; i < span; i++) slots[cursor + i] = picked.weatherId;
        cursor += Math.max(1, minSlots + Math.floor((maxSlots - minSlots) * rng()));
      }
    }

    for (const group of GROUP_CONFIG) {
      if (!group.fixedTimeSlots) continue;
      const span = slotSpan(group.durationMinutes);
      for (const start of group.fixedTimeSlots) {
        const picked = weightedPick(group.dropTable, rng);
        for (let i = 0; i < span; i++) slots[start + i] = picked.weatherId;
      }
    }
    return slots;
  }

  const scheduleCache = new Map();
  function getScheduleForDay(dayKey) {
    if (!scheduleCache.has(dayKey)) scheduleCache.set(dayKey, generateDaySchedule(dayKey));
    return scheduleCache.get(dayKey);
  }

  function currentWeatherAt(date) {
    return getScheduleForDay(dayKeyFor(date))[slotIndexFor(date)] ?? null;
  }

  function extendRun(schedule, startSlot, weatherId) {
    let end = startSlot;
    while (end < SLOTS_PER_DAY - 1 && schedule[end + 1] === weatherId) end++;
    return end;
  }

  // Finds the next slot (within LOOKAHEAD_DAYS) whose weather ID
  // satisfies `predicate`, searching forward from `fromDate`.
  function findNextEvent(fromDate, predicate) {
    const currentSlot = slotIndexFor(fromDate);
    const activeWeather = currentWeatherAt(fromDate);
    let searchStart = currentSlot + 1;
    if (activeWeather !== null) {
      const todaySchedule = getScheduleForDay(dayKeyFor(fromDate));
      searchStart = extendRun(todaySchedule, currentSlot, activeWeather) + 1;
    }

    for (let dayOffset = 0; dayOffset < LOOKAHEAD_DAYS; dayOffset++) {
      const dayRefDate = dayOffset === 0 ? fromDate : addDays(fromDate, dayOffset);
      const schedule = getScheduleForDay(dayKeyFor(dayRefDate));
      const startSlot = dayOffset === 0 ? searchStart : 0;
      for (let slot = startSlot; slot < SLOTS_PER_DAY; slot++) {
        const weatherId = schedule[slot];
        if (weatherId === undefined || !predicate(weatherId)) continue;
        const endSlot = extendRun(schedule, slot, weatherId);
        return { weatherId, startsAtMs: slotToMs(dayRefDate, slot), endsAtMs: slotToMs(dayRefDate, endSlot + 1) };
      }
    }
    return null;
  }

  function nextAnyWeather(date) {
    return findNextEvent(date, () => true);
  }
  function nextLunarWeather(date) {
    return findNextEvent(date, (id) => WEATHER_META[id].groupId === GROUP.LUNAR);
  }

  // ============================================================
  // Live current-weather (from room sync, independent of the
  // forecast engine above) + rendering.
  // ============================================================
  let currentWeatherId = "Clear";
  let lastChangedAt = null;
  let history = []; // { weatherId, endedAt }, most recent first
  const MAX_HISTORY = 20;

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>'"]/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
    })[c]);
  }

  // Compares two "x.y.z" version strings. Returns >0 if `a` is newer,
  // <0 if `b` is newer, 0 if equal (missing segments treated as 0).
  function compareVersions(a, b) {
    const partsA = String(a).split(".").map(Number);
    const partsB = String(b).split(".").map(Number);
    const len = Math.max(partsA.length, partsB.length);
    for (let i = 0; i < len; i++) {
      const diff = (partsA[i] || 0) - (partsB[i] || 0);
      if (diff !== 0) return diff;
    }
    return 0;
  }

  let remoteVersion = null;
  let versionCheckError = "";
  let hasConnectedOnce = false;

  function checkForUpdate() {
    GM_xmlhttpRequest({
      method: "GET",
      url: VERSION_CHECK_URL,
      onload: (response) => {
        if (response.status < 200 || response.status >= 300) {
          versionCheckError = `Check failed (${response.status})`;
          render();
          return;
        }
        const match = response.responseText.match(/@version\s+([\d.]+)/);
        if (match) {
          remoteVersion = match[1];
          versionCheckError = "";
        } else {
          versionCheckError = "Version not found in remote file";
        }
        render();
      },
      onerror: () => {
        versionCheckError = "Could not reach update check URL";
        render();
      }
    });
  }

  function weatherDisplay(id) {
    if (!id || id === "Clear") return { label: "Clear", icon: "\u2600\uFE0F" };
    return WEATHER_META[id] ?? { label: id, icon: "\uD83C\uDF00" };
  }

  function formatDuration(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    if (hours) return `${hours}h ${String(minutes).padStart(2, "0")}m ${String(seconds).padStart(2, "0")}s`;
    if (minutes) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
    return `${seconds}s`;
  }
  function formatClockTime(ts) {
    return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  function upcomingRowHtml(icon, label, remainingMs) {
    const timeLabel = remainingMs > 0 ? `in ${formatDuration(remainingMs)}` : "starting now";
    return `<span class="ws-forecast-icon">${icon}</span><span class="ws-forecast-label">${escapeHtml(label)}</span><span class="ws-forecast-time">${timeLabel}</span>`;
  }

  function render() {
    const panel = document.getElementById("ws-panel");
    if (!panel) return;

    const current = weatherDisplay(currentWeatherId);
    const activeFor = lastChangedAt ? formatDuration(Date.now() - lastChangedAt) : "--";
    panel.querySelector(".ws-current-icon").textContent = current.icon;
    panel.querySelector(".ws-current-label").textContent = current.label;
    panel.querySelector(".ws-current-since").textContent = `Active for ${activeFor}`;

    const now = new Date();

    // "Next weather": the literal next event of any type. If it happens
    // to be lunar-group, show it generically -- matches the game's own
    // dialog, which never reveals Dawn vs. Amber Moon ahead of time.
    const nextEvent = nextAnyWeather(now);
    const nextEl = panel.querySelector(".ws-next");
    if (nextEvent) {
      const isLunar = WEATHER_META[nextEvent.weatherId].groupId === GROUP.LUNAR;
      const { icon, label } = isLunar ? { icon: "\u2753", label: "Lunar" } : weatherDisplay(nextEvent.weatherId);
      nextEl.innerHTML = upcomingRowHtml(icon, label, nextEvent.startsAtMs - now.getTime());
    } else {
      nextEl.innerHTML = `<span class="ws-forecast-label ws-dim">Not available</span>`;
    }

    // "Next lunar": the next lunar-group occurrence specifically, always
    // shown generically (never reveals Dawn vs. Amber Moon in advance).
    const nextLunar = nextLunarWeather(now);
    const nextLunarEl = panel.querySelector(".ws-next-lunar");
    nextLunarEl.innerHTML = nextLunar
      ? upcomingRowHtml("\u2753", "Lunar", nextLunar.startsAtMs - now.getTime())
      : `<span class="ws-forecast-label ws-dim">Not available</span>`;

    const historyEl = panel.querySelector(".ws-history");
    historyEl.innerHTML = history.length
      ? history.map(({ weatherId, endedAt }) => {
          const info = weatherDisplay(weatherId);
          return `<div class="ws-history-row"><span class="ws-history-icon">${info.icon}</span><span class="ws-history-label">${escapeHtml(info.label)}</span><span class="ws-history-time">ended ${formatClockTime(endedAt)}</span></div>`;
        }).join("")
      : `<p class="ws-empty">No changes observed yet this session.</p>`;

    const connectionDot = panel.querySelector(".ws-connection-dot");
    const connectionLabel = panel.querySelector(".ws-connection-label");
    connectionDot.classList.toggle("ws-dot-online", hasConnectedOnce);
    connectionLabel.textContent = hasConnectedOnce ? "Connected" : "Connecting...";

    const versionEl = panel.querySelector(".ws-version");
    const isOutdated = remoteVersion && compareVersions(remoteVersion, SCRIPT_VERSION) > 0;
    versionEl.classList.toggle("ws-version-outdated", !!isOutdated);
    versionEl.textContent = isOutdated
      ? `Update available (v${remoteVersion})`
      : remoteVersion
        ? `v${SCRIPT_VERSION} \u2014 Up to date`
        : versionCheckError
          ? `v${SCRIPT_VERSION}`
          : `v${SCRIPT_VERSION} \u2014 Checking...`;
    versionEl.title = versionCheckError || "";
  }

  function handleRoomPatch(_patches, fullState) {
    hasConnectedOnce = true;
    const weatherId = fullState?.child?.data?.weather ?? "Clear";
    if (weatherId !== currentWeatherId) {
      history.unshift({ weatherId: currentWeatherId, endedAt: Date.now() });
      history = history.slice(0, MAX_HISTORY);
      currentWeatherId = weatherId;
      lastChangedAt = Date.now();
    } else if (lastChangedAt == null) {
      lastChangedAt = Date.now();
    }
    render();
  }

  // ============================================================
  // Mount
  // ============================================================
  function mount() {
    const style = document.createElement("style");
    style.textContent = `
      #ws-button{position:fixed;left:10px;bottom:98px;z-index:2147483647;width:32px;height:32px;padding:0;display:grid;place-items:center;border:1px solid #1e3a55;border-radius:8px;background:rgba(10,20,30,.85);color:#7ec8f2;font-size:16px;cursor:pointer;box-shadow:0 8px 24px rgba(0,0,0,.45)}
      #ws-panel{position:fixed;left:48px;bottom:98px;z-index:2147483647;width:290px;max-height:min(70vh,560px);display:flex;flex-direction:column;overflow:hidden;background:#0c0f14;border:1px solid rgba(126,200,242,.15);border-radius:10px;box-shadow:0 18px 55px rgba(0,0,0,.6);color:#e4e4e7;font:12px/1.4 system-ui,sans-serif}
      #ws-panel[hidden]{display:none}
      #ws-panel header{display:flex;align-items:center;justify-content:space-between;padding:8px 10px;border-bottom:1px solid rgba(126,200,242,.12);font-weight:700}
      #ws-panel header button{background:none;border:0;color:#999;cursor:pointer;font-size:14px}
      .ws-body{overflow:auto;padding:10px;display:flex;flex-direction:column;gap:10px}
      .ws-current{display:flex;flex-direction:column;align-items:center;gap:4px;padding:14px 10px;border:1px solid rgba(126,200,242,.15);border-radius:8px;background:rgba(126,200,242,.05)}
      .ws-current-icon{font-size:32px;line-height:1}
      .ws-current-label{font-size:15px;font-weight:700}
      .ws-current-since{color:#8fb8cf;font-size:10px}
      .ws-section-label{color:#7ba3ba;font-size:9px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;margin-top:2px}
      .ws-upcoming-row{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:6px;padding:8px;border:1px solid rgba(126,200,242,.15);border-radius:8px;background:rgba(126,200,242,.04)}
      .ws-forecast-icon{font-size:16px}
      .ws-forecast-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}
      .ws-forecast-time{color:#a3d9ff;font-size:11px;white-space:nowrap;font-weight:700}
      .ws-dim{color:#666;font-weight:400}
      .ws-history{display:flex;flex-direction:column;gap:4px;max-height:220px;overflow-y:auto;padding-right:2px}
      .ws-history-row{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:6px;padding:5px 6px;border:1px solid rgba(255,255,255,.06);border-radius:6px;background:rgba(255,255,255,.02);font-size:11px}
      .ws-history-icon{font-size:14px}
      .ws-history-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .ws-history-time{color:#777;font-size:10px;white-space:nowrap}
      .ws-empty{color:#777;text-align:center;padding:8px 0;margin:0}
      .ws-footer-row{display:flex;align-items:center;justify-content:space-between;gap:8px;padding-top:6px;border-top:1px solid rgba(255,255,255,.06);font-size:10px}
      .ws-connection{display:flex;align-items:center;gap:5px;color:#888}
      .ws-connection-dot{width:7px;height:7px;border-radius:50%;background:#555}
      .ws-connection-dot.ws-dot-online{background:#4ade80;box-shadow:0 0 6px rgba(74,222,128,.6)}
      .ws-version{color:#888}
      .ws-version.ws-version-outdated{color:#f87171;font-weight:700}
    `;
    document.head.appendChild(style);

    const button = document.createElement("button");
    button.id = "ws-button";
    button.textContent = "\u26C5";
    button.title = "Weather Station";
    document.body.appendChild(button);

    const panel = document.createElement("div");
    panel.id = "ws-panel";
    panel.hidden = true;
    panel.innerHTML = `
      <header><span>Weather Station</span><button data-close>&times;</button></header>
      <div class="ws-body">
        <div class="ws-current">
          <span class="ws-current-icon">\u2753</span>
          <span class="ws-current-label">Unknown</span>
          <span class="ws-current-since">Waiting for weather data...</span>
        </div>
        <div class="ws-section-label">Next weather</div>
        <div class="ws-upcoming-row ws-next"></div>
        <div class="ws-section-label">Next lunar</div>
        <div class="ws-upcoming-row ws-next-lunar"></div>
        <div class="ws-section-label">Recent changes (this session)</div>
        <div class="ws-history"></div>
        <div class="ws-footer-row">
          <span class="ws-connection"><span class="ws-connection-dot"></span><span class="ws-connection-label">Connecting...</span></span>
          <span class="ws-version"></span>
        </div>
      </div>
    `;
    document.body.appendChild(panel);

    const panelManager = getPanelManager();
    panelManager.register(PANEL_ID, panel, button, () => { panel.hidden = true; });

    button.onclick = (e) => {
      e.stopPropagation();
      if (panel.hidden) {
        panelManager.closeAllExcept(PANEL_ID);
        panel.hidden = false;
        render();
      } else {
        panel.hidden = true;
      }
    };
    panel.addEventListener("click", (e) => e.stopPropagation());
    panel.querySelector("[data-close]").onclick = () => (panel.hidden = true);

    render();
    subscribeToRoomPatches(handleRoomPatch);
    checkForUpdate();
    setInterval(checkForUpdate, VERSION_CHECK_INTERVAL_MS);
    setInterval(() => {
      if (!panel.hidden) render();
    }, 1000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount, { once: true });
  } else {
    mount();
  }
})();