
const BACKEND_HTTP_BASE = "https://temp-kopk.onrender.com"; // deployed backend
const API_BASE = `${BACKEND_HTTP_BASE}/api/v1`;
const WS_URL = `wss://temp-kopk.onrender.com`; // use wss for secure websocket

// === Helpers ===
const qs = (sel) => document.querySelector(sel);
const qsa = (sel) => Array.from(document.querySelectorAll(sel));

function showToast({ title, body, variant = "primary" }) {
    const container = qs("#toastContainer");
    if (!container) return;

    const toastEl = document.createElement("div");
    toastEl.className = "toast align-items-center text-bg-" + variant;
    toastEl.setAttribute("role", "alert");
    toastEl.setAttribute("aria-live", "assertive");
    toastEl.setAttribute("aria-atomic", "true");

    toastEl.innerHTML = `
        <div class="toast-header">
            <strong class="me-auto">${title}</strong>
            <button type="button" class="btn-close btn-close-white ms-2 mb-1" data-bs-dismiss="toast" aria-label="Close"></button>
        </div>
        <div class="toast-body">
            ${body}
        </div>
    `;

    container.appendChild(toastEl);
    const toast = new bootstrap.Toast(toastEl, { delay: 3000 });
    toast.show();
    toastEl.addEventListener("hidden.bs.toast", () => toastEl.remove());
}

function classifyHeatIndex(hi) {
    if (hi == null || isNaN(hi)) return { label: "N/A", className: "" };
    if (hi < 27) return { label: "Normal", className: "badge-level-normal" };
    if (hi < 32)
        return { label: "Caution", className: "badge-level-caution" };
    if (hi < 41)
        return {
            label: "Extreme Caution",
            className: "badge-level-extreme-caution",
        };
    if (hi < 54) return { label: "Danger", className: "badge-level-danger" };
    return {
        label: "Extreme Danger",
        className: "badge-level-extreme-danger",
    };
}

function classifyLight(light) {
    if (light == null || isNaN(light))
        return { label: "N/A", className: "badge-secondary" };
    if (light < 30)
        return { label: "DARK", className: "badge-light-dark text-uppercase" };
    if (light < 70)
        return {
            label: "CLOUDY",
            className: "badge-light-cloudy text-uppercase",
        };
    return {
        label: "SUNNY",
        className: "badge-light-sunny text-uppercase",
    };
}

function calcTrend(prev, current) {
    if (prev == null || current == null || isNaN(prev) || isNaN(current))
        return "N/A";
    if (Math.abs(current - prev) < 0.05) return "Stable";
    return current > prev ? "Rising" : "Falling";
}

function parsePhoneNumbers(raw) {
    return raw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
}

function renderPhoneNumberChips(numbers) {
    const container = qs("#phoneNumbersChips");
    if (!container) return;

    container.innerHTML = "";
    if (!numbers || numbers.length === 0) {
        const span = document.createElement("span");
        span.className = "text-muted small";
        span.textContent = "No phone numbers configured.";
        container.appendChild(span);
        return;
    }

    numbers.forEach((num) => {
        const badge = document.createElement("span");
        badge.className =
            "badge rounded-pill text-bg-light border d-inline-flex align-items-center gap-1";
        badge.innerHTML = `
            <span>${num}</span>
            <button
                type="button"
                class="btn btn-sm btn-link p-0 m-0 text-danger phone-chip-remove"
                data-number="${num}"
                aria-label="Remove ${num}"
            >
                ×
            </button>
        `;
        container.appendChild(badge);
    });
}

// === Charts & history ===
let tempChart;
let humidityChart;
let heatIndexChart;
let lightChart;

const HISTORY_DEFAULT_PAGE_SIZE = 10;
let historyRecords = [];
let historyAvailableDates = new Set();
const historyFilters = {
    date: null,
    page: 1,
    timeQuery: "",
    pageSize: HISTORY_DEFAULT_PAGE_SIZE,
    sortKey: "createdAt", // 'createdAt', 'temperature', 'heatIndex', 'humidity', 'light'
    sortDir: "desc", // 'asc' | 'desc'
};

function createLineChart(ctx, label, color, suggestedMax) {
    return new Chart(ctx, {
        type: "line",
        data: {
            labels: [],
            datasets: [
                {
                    label,
                    data: [],
                    borderColor: color,
                    backgroundColor: color.replace("rgb", "rgba").replace(")", ", 0.08)"),
                    tension: 0.3,
                    fill: true,
                    borderWidth: 2,
                    pointRadius: 0,
                },
            ],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    labels: { color: "#4b5563" },
                },
            },
            scales: {
                x: {
                    ticks: { color: "#6b7280" },
                    grid: { color: "rgba(209, 213, 219, 0.6)" },
                },
                y: {
                    ticks: { color: "#6b7280" },
                    grid: { color: "rgba(209, 213, 219, 0.6)" },
                    beginAtZero: true,
                    suggestedMax: suggestedMax,
                },
            },
        },
    });
}

function initCharts() {
    const tempCtx = document.getElementById("tempChart");
    const humidityCtx = document.getElementById("humidityChart");
    const heatIdxCtx = document.getElementById("heatIndexChart");
    const lightCtx = document.getElementById("lightChart");

    tempChart = createLineChart(tempCtx, "Temperature (°C)", "rgb(59, 130, 246)");
    humidityChart = createLineChart(humidityCtx, "Humidity (%)", "rgb(34, 197, 94)");
    heatIndexChart = createLineChart(
        heatIdxCtx,
        "Heat Index (°C)",
        "rgb(239, 68, 68)"
    );
    // Allow headroom above maximum for light so the line doesn't hit the top
    lightChart = createLineChart(lightCtx, "Light Level", "rgb(234, 179, 8)", 120);
}

function normalizeDateOnly(dateLike) {
    const d = new Date(dateLike);
    if (Number.isNaN(d.getTime())) return null;
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
}

function updateHistoryDateInputMeta() {
    const input = qs("#historyDateFilter");
    if (!input) return;

    const dates = Array.from(historyAvailableDates).sort();
    if (!dates.length) {
        input.min = "";
        input.max = "";
        input.disabled = true;
        return;
    }

    input.disabled = false;
    input.min = dates[0];
    input.max = dates[dates.length - 1];
}

function addHistoryRecord(d) {
    const createdAt = d.createdAt || Date.now();
    historyRecords.push({
        createdAt: d.createdAt || Date.now(),
        temperature: d.temperature ?? null,
        heatIndex: d.heatIndex ?? null,
        humidity: d.humidity ?? null,
        light: d.light ?? null,
    });

    const dateOnly = normalizeDateOnly(createdAt);
    if (dateOnly) {
        historyAvailableDates.add(dateOnly);
    }

    updateHistoryDateInputMeta();
}

function setInitialHistory(records) {
    historyRecords = [];
    historyAvailableDates = new Set();
    records.forEach((d) => addHistoryRecord(d));
    historyFilters.page = 1;

    // If the current date filter is not in the available dates anymore, clear it
    if (
        historyFilters.date &&
        !historyAvailableDates.has(historyFilters.date)
    ) {
        historyFilters.date = null;
    }

    renderHistoryTables();
}

async function loadFullHistoryFromApi() {
    try {
        const res = await fetch(`${API_BASE}/data/all`);
        if (!res.ok) {
            throw new Error(`Failed to load history: ${res.status}`);
        }
        const json = await res.json();
        if (!Array.isArray(json)) {
            console.warn("Unexpected history response format", json);
            return;
        }
        setInitialHistory(json);
        console.log(`Loaded ${json.length} historical records from API.`);
    } catch (err) {
        console.error("Error loading full history from API:", err);
        showToast({
            title: "History",
            body: "Failed to load full history from server.",
            variant: "danger",
        });
    }
}

function getFilteredSortedHistory() {
    let recs = [...historyRecords];
    if (historyFilters.date) {
        recs = recs.filter((r) => {
            const recDate = normalizeDateOnly(r.createdAt);
            return recDate === historyFilters.date;
        });
    }

    if (historyFilters.timeQuery) {
        const q = historyFilters.timeQuery.toLowerCase();
        recs = recs.filter((r) => {
            const t = new Date(r.createdAt)
                .toLocaleTimeString()
                .toLowerCase();
            return t.includes(q);
        });
    }

    const { sortKey, sortDir } = historyFilters;
    recs.sort((a, b) => {
        let av;
        let bv;
        if (sortKey === "createdAt") {
            av = new Date(a.createdAt).getTime();
            bv = new Date(b.createdAt).getTime();
        } else {
            av = a[sortKey] ?? -Infinity;
            bv = b[sortKey] ?? -Infinity;
        }
        if (av < bv) return sortDir === "asc" ? -1 : 1;
        if (av > bv) return sortDir === "asc" ? 1 : -1;
        return 0;
    });
    return recs;
}

function getHistoryPage() {
    const all = getFilteredSortedHistory();
    const totalCount = all.length;
    const pageSize = historyFilters.pageSize || HISTORY_DEFAULT_PAGE_SIZE;
    const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
    if (historyFilters.page > totalPages) {
        historyFilters.page = totalPages;
    }
    const start = (historyFilters.page - 1) * pageSize;
    const pageRecords = all.slice(start, start + pageSize);
    return { pageRecords, totalPages, totalCount };
}

function renderHistoryTables() {
    const tempBody = qs("#tempHistoryBody");
    const hiBody = qs("#heatIndexHistoryBody");
    const humBody = qs("#humidityHistoryBody");
    const lightBody = qs("#lightHistoryBody");
    const pageInfoEl = qs("#historyPageInfo");
    const prevBtn = qs("#historyPrevPage");
    const nextBtn = qs("#historyNextPage");

    const { pageRecords, totalPages, totalCount } = getHistoryPage();

    const renderMetricTable = (tbody, metricKey, unitLabel) => {
        if (!tbody) return;
        tbody.innerHTML = "";
        const rowsForMetric = pageRecords.filter(
            (r) => r[metricKey] !== null && r[metricKey] !== undefined
        );
        if (!rowsForMetric.length) {
            const tr = document.createElement("tr");
            tr.className = "text-muted";
            tr.innerHTML = `
                <td colspan="2" class="text-center">No data for this selection.</td>
            `;
            tbody.appendChild(tr);
            return;
        }

        rowsForMetric.forEach((r) => {
            const dt = new Date(r.createdAt).toLocaleString();
            const tr = document.createElement("tr");
            tr.innerHTML = `
                <td>${dt}</td>
                <td>${r[metricKey] ?? "—"}${unitLabel ? " " + unitLabel : ""}</td>
            `;
            tbody.appendChild(tr);
        });
    };

    renderMetricTable(tempBody, "temperature", "");
    renderMetricTable(hiBody, "heatIndex", "");
    renderMetricTable(humBody, "humidity", "");
    renderMetricTable(lightBody, "light", "");

    if (pageInfoEl) {
        pageInfoEl.textContent = `Page ${historyFilters.page} of ${totalPages} (${totalCount} record${totalCount === 1 ? "" : "s"})`;
    }
    if (prevBtn) {
        prevBtn.disabled = historyFilters.page <= 1 || totalCount === 0;
    }
    if (nextBtn) {
        nextBtn.disabled =
            historyFilters.page >= totalPages || totalCount === 0;
    }
}

function updateChartsFromInitial(dataArr) {
    const labels = dataArr.map((d) =>
        new Date(d.createdAt || Date.now()).toLocaleTimeString()
    );
    const temps = dataArr.map((d) => d.temperature ?? null);
    const heatIdx = dataArr.map((d) => d.heatIndex ?? null);
    const hums = dataArr.map((d) => d.humidity ?? null);
    const lights = dataArr.map((d) => d.light ?? null);

    [tempChart, humidityChart, heatIndexChart, lightChart].forEach((chart) => {
        chart.data.labels = labels.slice(-10);
    });

    tempChart.data.datasets[0].data = temps.slice(-10);
    humidityChart.data.datasets[0].data = hums.slice(-10);
    heatIndexChart.data.datasets[0].data = heatIdx.slice(-10);
    lightChart.data.datasets[0].data = lights.slice(-10);

    // Seed the history tables
    setInitialHistory(dataArr);

    tempChart.update("none");
    humidityChart.update("none");
    heatIndexChart.update("none");
    lightChart.update("none");
}

function pushNewDataPoint(d) {
    const label = new Date(d.createdAt || Date.now()).toLocaleTimeString();

    const charts = [tempChart, humidityChart, heatIndexChart, lightChart];
    charts.forEach((chart) => {
        chart.data.labels.push(label);
        if (chart.data.labels.length > 10) {
            chart.data.labels.shift();
        }
    });

    tempChart.data.datasets[0].data.push(d.temperature ?? null);
    humidityChart.data.datasets[0].data.push(d.humidity ?? null);
    heatIndexChart.data.datasets[0].data.push(d.heatIndex ?? null);
    lightChart.data.datasets[0].data.push(d.light ?? null);

    [tempChart, humidityChart, heatIndexChart, lightChart].forEach((chart) => {
        if (chart.data.datasets[0].data.length > 10) {
            chart.data.datasets[0].data.shift();
        }
        chart.update("none");
    });

    // Also append to history
    addHistoryRecord(d);
    renderHistoryTables();
}

// === Sensor UI ===
let lastTemp = null;
let lastHumidity = null;

function updateSensorUI(d) {
    const temp = Number(d.temperature);
    const hum = Number(d.humidity);
    const hi = Number(d.heatIndex);
    const light = Number(d.light);

    const lightStatusLabel = qs("#lightStatusLabel");
    const lightClass = classifyLight(light);
    if (lightStatusLabel) {
        lightStatusLabel.textContent = lightClass.label;
        lightStatusLabel.className = `badge small ${lightClass.className}`;
    }
}

// === WebSocket for live data ===
let ws;
let wsReconnectTimeout = null;

function setWsStatus(status) {
    const dot = qs("#wsStatusDot");
    const text = qs("#wsStatusText");
    if (!dot || !text) return;

    dot.classList.remove("connected", "connecting");
    if (status === "connected") {
        dot.classList.add("connected");
        text.textContent = "Connected";
    } else if (status === "connecting") {
        dot.classList.add("connecting");
        text.textContent = "Connecting…";
    } else {
        text.textContent = "Disconnected";
    }
}

function connectWebSocket() {
    try {
        setWsStatus("connecting");
        ws = new WebSocket(WS_URL);

        ws.onopen = () => {
            setWsStatus("connected");
            showToast({
                title: "Live data",
                body: "WebSocket connection established.",
                variant: "success",
            });
        };

        ws.onmessage = (ev) => {
            try {
                const msg = JSON.parse(ev.data);
                if (msg.type === "initial" && Array.isArray(msg.data)) {
                    updateChartsFromInitial(msg.data);
                    const last = msg.data[msg.data.length - 1];
                    if (last) updateSensorUI(last);
                } else if (msg.type === "update" && msg.data) {
                    pushNewDataPoint(msg.data);
                    updateSensorUI(msg.data);
                }
            } catch (err) {
                console.error("WebSocket message parse error:", err);
            }
        };

        ws.onclose = () => {
            setWsStatus("disconnected");
            showToast({
                title: "Live data",
                body: "WebSocket disconnected. Will retry in 3s.",
                variant: "warning",
            });
            if (wsReconnectTimeout) clearTimeout(wsReconnectTimeout);
            wsReconnectTimeout = setTimeout(connectWebSocket, 3000);
        };

        ws.onerror = (err) => {
            console.error("WebSocket error:", err);
        };
    } catch (err) {
        console.error("WebSocket connect error:", err);
        setWsStatus("disconnected");
    }
}

// === SMS settings & alerts ===
let currentSmsSettings = null;

async function loadSmsSettings() {
    const statusBadge = qs("#smsSettingsStatus");
    try {
        if (statusBadge) {
            statusBadge.textContent = "Loading…";
            statusBadge.className = "badge bg-secondary small";
        }
        const res = await fetch(`${API_BASE}/sms-settings`);
        if (!res.ok) throw new Error("Failed to load SMS settings");
        const json = await res.json();
        if (!json.success) throw new Error(json.error || "Invalid response");

        currentSmsSettings = json.data || {};
        populateSmsSettingsForm(currentSmsSettings);

        if (statusBadge) {
            statusBadge.textContent = "Loaded";
            statusBadge.className = "badge bg-success small";
        }
        showToast({
            title: "SMS settings",
            body: "Loaded from backend.",
            variant: "success",
        });
    } catch (err) {
        console.error(err);
        if (statusBadge) {
            statusBadge.textContent = "Error";
            statusBadge.className = "badge bg-danger small";
        }
        showToast({
            title: "SMS settings",
            body: "Failed to load SMS settings.",
            variant: "danger",
        });
    }
}

function populateSmsSettingsForm(settings) {
    const phoneNumbersArr = settings.phoneNumbers || [];
    const phoneNumbers = phoneNumbersArr.join(",");

    const phoneInput = qs("#phoneNumbersInput");
    const enableInput = qs("#enableAlertsInput");
    const cooldownInput = qs("#cooldownMinutesInput");

    if (phoneInput) phoneInput.value = phoneNumbers;
    if (enableInput) enableInput.checked = !!settings.enableAlerts;
    if (cooldownInput)
        cooldownInput.value =
            settings.cooldownMinutes != null ? settings.cooldownMinutes : 30;

    renderPhoneNumberChips(phoneNumbersArr);
    renderCustomAlerts(settings.customAlerts || []);
    renderScheduledAlerts(settings.scheduledAlerts || []);
}

function collectSmsSettingsFromForm() {
    const numbers = parsePhoneNumbers(qs("#phoneNumbersInput").value);
    renderPhoneNumberChips(numbers);

    return {
        phoneNumbers: numbers,
        enableAlerts: qs("#enableAlertsInput").checked,
        thresholds: currentSmsSettings?.thresholds || {
            caution: true,
            extremeCaution: true,
            danger: true,
            extremeDanger: true,
        },
        cooldownMinutes: Number(qs("#cooldownMinutesInput").value) || 30,
        customAlerts: currentSmsSettings?.customAlerts || [],
        scheduledAlerts: currentSmsSettings?.scheduledAlerts || [],
    };
}

async function saveSmsSettings(e) {
    e.preventDefault();
    const btn = qs("#saveSmsSettingsBtn");
    if (btn) {
        btn.disabled = true;
        btn.innerHTML =
            '<span class="spinner-border spinner-border-sm me-1" role="status"></span>Saving...';
    }

    try {
        const payload = collectSmsSettingsFromForm();
        const res = await fetch(`${API_BASE}/sms-settings`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });
        if (!res.ok) throw new Error("Failed to save SMS settings");
        const json = await res.json();
        if (!json.success) throw new Error(json.error || "Invalid response");

        currentSmsSettings = json.data || payload;
        populateSmsSettingsForm(currentSmsSettings);

        showToast({
            title: "SMS settings",
            body: "Settings saved successfully.",
            variant: "success",
        });
    } catch (err) {
        console.error(err);
        showToast({
            title: "SMS settings",
            body: "Failed to save SMS settings.",
            variant: "danger",
        });
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML =
                '<i class="fa-solid fa-floppy-disk me-1"></i>Save SMS Settings';
        }
    }
}

// --- Custom Alerts ---
function renderCustomAlerts(alerts) {
    const tbody = qs("#customAlertsTableBody");
    const countBadge = qs("#customAlertCount");
    if (!tbody) return;

    tbody.innerHTML = "";
    if (!alerts || alerts.length === 0) {
        tbody.innerHTML = `
            <tr class="text-muted">
                <td colspan="5" class="text-center">No custom alerts configured.</td>
            </tr>
        `;
    } else {
        alerts.forEach((a) => {
            const tr = document.createElement("tr");
            tr.innerHTML = `
                <td>${a.metric}</td>
                <td>${a.condition}</td>
                <td>${a.value}</td>
                <td>${a.message}</td>
                <td class="text-end">
                    <button class="btn btn-sm btn-outline-light btn-edit-custom" data-id="${a.id}">
                        <i class="fa-solid fa-pen"></i>
                    </button>
                    <button class="btn btn-sm btn-outline-danger ms-1 btn-delete-custom" data-id="${a.id}">
                        <i class="fa-solid fa-trash"></i>
                    </button>
                </td>
            `;
            tbody.appendChild(tr);
        });
    }

    if (countBadge) {
        const n = alerts ? alerts.length : 0;
        countBadge.textContent = `${n} alert${n === 1 ? "" : "s"}`;
    }
}

async function upsertCustomAlert(e) {
    e.preventDefault();
    const idField = qs("#customAlertId");
    const metric = qs("#customAlertMetric").value;
    const condition = qs("#customAlertCondition").value;
    const value = Number(qs("#customAlertValue").value);
    const message = qs("#customAlertMessage").value.trim();

    if (!message || isNaN(value)) {
        showToast({
            title: "Custom alert",
            body: "Please provide a numeric value and message.",
            variant: "warning",
        });
        return;
    }

    const isEditing = !!idField.value;
    const endpoint = `${API_BASE}/sms-settings/custom-alert` + (isEditing ? `/${idField.value}` : "");
    const method = isEditing ? "PUT" : "POST";

    try {
        const res = await fetch(endpoint, {
            method,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                id: idField.value || undefined,
                metric,
                condition,
                value,
                message,
            }),
        });
        if (!res.ok) throw new Error("Failed to save custom alert");
        const json = await res.json();
        if (!json.success) throw new Error(json.error || "Invalid response");

        // Refresh settings from backend to get updated arrays
        await loadSmsSettings();

        idField.value = "";
        qs("#customAlertForm").reset();
        qs("#customAlertMetric").value = "temperature";
        qs("#customAlertCondition").value = "greater";

        const cancelBtn = qs("#cancelEditCustomAlertBtn");
        const submitLabel = qs("#customAlertSubmitLabel");
        if (cancelBtn) cancelBtn.classList.add("d-none");
        if (submitLabel) submitLabel.textContent = "Add Alert";

        showToast({
            title: "Custom alert",
            body: isEditing ? "Alert updated." : "Alert added.",
            variant: "success",
        });
    } catch (err) {
        console.error(err);
        showToast({
            title: "Custom alert",
            body: "Failed to save alert.",
            variant: "danger",
        });
    }
}

async function deleteCustomAlert(id) {
    if (!id) return;
    if (!confirm("Delete this custom alert?")) return;

    try {
        const res = await fetch(`${API_BASE}/sms-settings/custom-alert/${id}`, {
            method: "DELETE",
        });
        if (!res.ok) throw new Error("Failed to delete custom alert");
        const json = await res.json();
        if (!json.success) throw new Error(json.error || "Invalid response");

        await loadSmsSettings();
        showToast({
            title: "Custom alert",
            body: "Alert deleted.",
            variant: "success",
        });
    } catch (err) {
        console.error(err);
        showToast({
            title: "Custom alert",
            body: "Failed to delete alert.",
            variant: "danger",
        });
    }
}

function startEditCustomAlert(id) {
    const alert = (currentSmsSettings?.customAlerts || []).find(
        (a) => String(a.id) === String(id)
    );
    if (!alert) return;

    qs("#customAlertId").value = alert.id;
    qs("#customAlertMetric").value = alert.metric;
    qs("#customAlertCondition").value = alert.condition;
    qs("#customAlertValue").value = alert.value;
    qs("#customAlertMessage").value = alert.message;

    const cancelBtn = qs("#cancelEditCustomAlertBtn");
    const submitLabel = qs("#customAlertSubmitLabel");
    if (cancelBtn) cancelBtn.classList.remove("d-none");
    if (submitLabel) submitLabel.textContent = "Update Alert";
}

function cancelEditCustomAlert() {
    const form = qs("#customAlertForm");
    if (form) form.reset();
    qs("#customAlertId").value = "";
    const cancelBtn = qs("#cancelEditCustomAlertBtn");
    const submitLabel = qs("#customAlertSubmitLabel");
    if (cancelBtn) cancelBtn.classList.add("d-none");
    if (submitLabel) submitLabel.textContent = "Add Alert";
}

// --- Scheduled Alerts ---
function renderScheduledAlerts(alerts) {
    const tbody = qs("#scheduledAlertsTableBody");
    const countBadge = qs("#scheduledAlertCount");
    if (!tbody) return;

    tbody.innerHTML = "";
    if (!alerts || alerts.length === 0) {
        tbody.innerHTML = `
            <tr class="text-muted">
                <td colspan="3" class="text-center">No scheduled alerts configured.</td>
            </tr>
        `;
    } else {
        alerts.forEach((a) => {
            const tr = document.createElement("tr");
            tr.innerHTML = `
                <td>${a.time}</td>
                <td>${a.message}</td>
                <td class="text-end">
                    <button class="btn btn-sm btn-outline-light btn-edit-scheduled" data-id="${a.id}">
                        <i class="fa-solid fa-pen"></i>
                    </button>
                    <button class="btn btn-sm btn-outline-danger ms-1 btn-delete-scheduled" data-id="${a.id}">
                        <i class="fa-solid fa-trash"></i>
                    </button>
                </td>
            `;
            tbody.appendChild(tr);
        });
    }

    if (countBadge) {
        const n = alerts ? alerts.length : 0;
        countBadge.textContent = `${n} alert${n === 1 ? "" : "s"}`;
    }
}

async function upsertScheduledAlert(e) {
    e.preventDefault();
    const idField = qs("#scheduledAlertId");
    const time = qs("#scheduledAlertTime").value;
    const message = qs("#scheduledAlertMessage").value.trim();

    if (!time || !message) {
        showToast({
            title: "Scheduled alert",
            body: "Please provide both time and message.",
            variant: "warning",
        });
        return;
    }

    const isEditing = !!idField.value;
    const endpoint =
        `${API_BASE}/sms-settings/scheduled-alert` +
        (isEditing ? `/${idField.value}` : "");
    const method = isEditing ? "PUT" : "POST";

    try {
        const res = await fetch(endpoint, {
            method,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                id: idField.value || undefined,
                time,
                message,
            }),
        });
        if (!res.ok) throw new Error("Failed to save scheduled alert");
        const json = await res.json();
        if (!json.success) throw new Error(json.error || "Invalid response");

        await loadSmsSettings();

        idField.value = "";
        qs("#scheduledAlertForm").reset();

        const cancelBtn = qs("#cancelEditScheduledAlertBtn");
        const submitLabel = qs("#scheduledAlertSubmitLabel");
        if (cancelBtn) cancelBtn.classList.add("d-none");
        if (submitLabel) submitLabel.textContent = "Add Schedule";

        showToast({
            title: "Scheduled alert",
            body: isEditing ? "Schedule updated." : "Schedule added.",
            variant: "success",
        });
    } catch (err) {
        console.error(err);
        showToast({
            title: "Scheduled alert",
            body: "Failed to save schedule.",
            variant: "danger",
        });
    }
}

async function deleteScheduledAlert(id) {
    if (!id) return;
    if (!confirm("Delete this scheduled alert?")) return;

    try {
        const res = await fetch(
            `${API_BASE}/sms-settings/scheduled-alert/${id}`,
            {
                method: "DELETE",
            }
        );
        if (!res.ok) throw new Error("Failed to delete scheduled alert");
        const json = await res.json();
        if (!json.success) throw new Error(json.error || "Invalid response");

        await loadSmsSettings();
        showToast({
            title: "Scheduled alert",
            body: "Schedule deleted.",
            variant: "success",
        });
    } catch (err) {
        console.error(err);
        showToast({
            title: "Scheduled alert",
            body: "Failed to delete schedule.",
            variant: "danger",
        });
    }
}

function startEditScheduledAlert(id) {
    const alert = (currentSmsSettings?.scheduledAlerts || []).find(
        (a) => String(a.id) === String(id)
    );
    if (!alert) return;

    qs("#scheduledAlertId").value = alert.id;
    qs("#scheduledAlertTime").value = alert.time;
    qs("#scheduledAlertMessage").value = alert.message;

    const cancelBtn = qs("#cancelEditScheduledAlertBtn");
    const submitLabel = qs("#scheduledAlertSubmitLabel");
    if (cancelBtn) cancelBtn.classList.remove("d-none");
    if (submitLabel) submitLabel.textContent = "Update Schedule";
}

function cancelEditScheduledAlert() {
    const form = qs("#scheduledAlertForm");
    if (form) form.reset();
    qs("#scheduledAlertId").value = "";
    const cancelBtn = qs("#cancelEditScheduledAlertBtn");
    const submitLabel = qs("#scheduledAlertSubmitLabel");
    if (cancelBtn) cancelBtn.classList.add("d-none");
    if (submitLabel) submitLabel.textContent = "Add Schedule";
}

// === Bootstrap wiring ===
function wireEventHandlers() {
    const smsForm = qs("#smsSettingsForm");
    if (smsForm) {
        smsForm.addEventListener("submit", saveSmsSettings);
    }

    const phoneInput = qs("#phoneNumbersInput");
    if (phoneInput) {
        phoneInput.addEventListener("input", () => {
            const numbers = parsePhoneNumbers(phoneInput.value);
            renderPhoneNumberChips(numbers);
        });
    }

    const customForm = qs("#customAlertForm");
    if (customForm) {
        customForm.addEventListener("submit", upsertCustomAlert);
    }

    const scheduledForm = qs("#scheduledAlertForm");
    if (scheduledForm) {
        scheduledForm.addEventListener("submit", upsertScheduledAlert);
    }

    const cancelCustomBtn = qs("#cancelEditCustomAlertBtn");
    if (cancelCustomBtn) {
        cancelCustomBtn.addEventListener("click", cancelEditCustomAlert);
    }

    const cancelScheduledBtn = qs("#cancelEditScheduledAlertBtn");
    if (cancelScheduledBtn) {
        cancelScheduledBtn.addEventListener("click", cancelEditScheduledAlert);
    }

    // History filters & pagination
    const dateFilterInput = qs("#historyDateFilter");
    const timeSearchInput = qs("#historyTimeSearch");
    const clearDateBtn = qs("#clearHistoryDateFilterBtn");
    const pageSizeSelect = qs("#historyPageSize");
    const prevPageBtn = qs("#historyPrevPage");
    const nextPageBtn = qs("#historyNextPage");

    if (dateFilterInput) {
        dateFilterInput.addEventListener("change", () => {
            const value = dateFilterInput.value || null;
            if (value && !historyAvailableDates.has(value)) {
                // Disallow selecting dates without data
                showToast({
                    title: "History filter",
                    body: "No data available for that date.",
                    variant: "warning",
                });
                dateFilterInput.value = historyFilters.date || "";
                return;
            }

            historyFilters.date = value;
            historyFilters.page = 1;
            renderHistoryTables();
        });
    }

    if (timeSearchInput) {
        timeSearchInput.addEventListener("input", () => {
            historyFilters.timeQuery = timeSearchInput.value.trim();
            historyFilters.page = 1;
            renderHistoryTables();
        });
    }

    if (clearDateBtn && dateFilterInput && timeSearchInput) {
        clearDateBtn.addEventListener("click", () => {
            dateFilterInput.value = "";
            historyFilters.date = null;
            timeSearchInput.value = "";
            historyFilters.timeQuery = "";
            historyFilters.page = 1;
            renderHistoryTables();
        });
    }

    if (pageSizeSelect) {
        pageSizeSelect.addEventListener("change", () => {
            const val = Number(pageSizeSelect.value) || HISTORY_DEFAULT_PAGE_SIZE;
            historyFilters.pageSize = val;
            historyFilters.page = 1;
            renderHistoryTables();
        });
    }

    if (prevPageBtn) {
        prevPageBtn.addEventListener("click", () => {
            if (historyFilters.page > 1) {
                historyFilters.page -= 1;
                renderHistoryTables();
            }
        });
    }

    if (nextPageBtn) {
        nextPageBtn.addEventListener("click", () => {
            const { totalPages } = getHistoryPage();
            if (historyFilters.page < totalPages) {
                historyFilters.page += 1;
                renderHistoryTables();
            }
        });
    }

    // Delegate clicks for dynamic tables, sorting & chips
    document.addEventListener("click", (e) => {
        const target = e.target.closest("button");
        if (!target) return;

        if (target.classList.contains("btn-edit-custom")) {
            const id = target.dataset.id;
            startEditCustomAlert(id);
        } else if (target.classList.contains("btn-delete-custom")) {
            const id = target.dataset.id;
            deleteCustomAlert(id);
        } else if (target.classList.contains("btn-edit-scheduled")) {
            const id = target.dataset.id;
            startEditScheduledAlert(id);
        } else if (target.classList.contains("btn-delete-scheduled")) {
            const id = target.dataset.id;
            deleteScheduledAlert(id);
        } else if (target.classList.contains("phone-chip-remove")) {
            const num = target.dataset.number;
            const phoneInputEl = qs("#phoneNumbersInput");
            if (!phoneInputEl || !num) return;
            const updated = parsePhoneNumbers(phoneInputEl.value).filter(
                (n) => n !== num
            );
            phoneInputEl.value = updated.join(", ");
            renderPhoneNumberChips(updated);
        } else if (target.classList.contains("history-sort")) {
            const key = target.dataset.sortKey;
            if (!key) return;

            if (historyFilters.sortKey === key) {
                historyFilters.sortDir =
                    historyFilters.sortDir === "asc" ? "desc" : "asc";
            } else {
                historyFilters.sortKey = key;
                historyFilters.sortDir = "asc";
            }
            historyFilters.page = 1;
            renderHistoryTables();
        }
    });
}

// === Init ===
window.addEventListener("DOMContentLoaded", async () => {
    // Real-time clock in navbar
    const clockEl = qs("#currentDateTime");
    if (clockEl) {
        const updateClock = () => {
            const now = new Date();
            clockEl.textContent = now.toLocaleString(undefined, {
                year: "numeric",
                month: "short",
                day: "2-digit",
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
            });
        };
        updateClock();
        setInterval(updateClock, 1000);
    }

    initCharts();
    wireEventHandlers();
    connectWebSocket();
    await loadSmsSettings();
    // Load full historical data once so the date filter sees all days with data
    await loadFullHistoryFromApi();
});

