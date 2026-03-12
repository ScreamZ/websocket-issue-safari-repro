type ConnectionState = "idle" | "connecting" | "open" | "closing" | "closed" | "retrying";
export {};

type LogEntry = {
	id: string;
	at: string;
	message: string;
	tone: "neutral" | "good" | "warn" | "bad";
};

type ReproConfig = {
	mode?: "plain";
	wsEndpoint?: string;
};

const RETRY_DELAY_MS = 1200;
const LOG_LIMIT = 80;
const fallbackWsUrl = `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/ws`;

const state = {
	connectionState: "idle" as ConnectionState,
	attempt: 0,
	retryInMs: 0,
	socketId: "-",
	lastError: "-",
	lastLifecycleEvent: "-",
	autoRetry: true,
	lifecycleCleanup: true,
	visibility: document.visibilityState,
	logs: [] as LogEntry[],
};

function getRequiredElement<T extends Element>(selector: string) {
	const element = document.querySelector<T>(selector);
	if (!element) {
		throw new Error(`Missing DOM element: ${selector}`);
	}
	return element;
}

const elements = {
	stateValue: getRequiredElement<HTMLElement>("#state-value"),
	attemptValue: getRequiredElement<HTMLElement>("#attempt-value"),
	retryValue: getRequiredElement<HTMLElement>("#retry-value"),
	visibilityValue: getRequiredElement<HTMLElement>("#visibility-value"),
	socketIdValue: getRequiredElement<HTMLElement>("#socket-id-value"),
	lifecycleValue: getRequiredElement<HTMLElement>("#lifecycle-value"),
	originValue: getRequiredElement<HTMLElement>("#origin-value"),
	wsUrlValue: getRequiredElement<HTMLElement>("#ws-url-value"),
	errorValue: getRequiredElement<HTMLElement>("#error-value"),
	logList: getRequiredElement<HTMLOListElement>("#log-list"),
	connectButton: getRequiredElement<HTMLButtonElement>("#connect-button"),
	disconnectButton: getRequiredElement<HTMLButtonElement>("#disconnect-button"),
	sendButton: getRequiredElement<HTMLButtonElement>("#send-button"),
	clearButton: getRequiredElement<HTMLButtonElement>("#clear-button"),
	autoRetryToggle: getRequiredElement<HTMLInputElement>("#auto-retry-toggle"),
	cleanupToggle: getRequiredElement<HTMLInputElement>("#cleanup-toggle"),
};

let config: ReproConfig = {};

try {
	const response = await fetch("/__repro-config", { cache: "no-store" });
	if (response.ok) {
		config = (await response.json()) as ReproConfig;
	}
} catch {
	// Use fallback endpoint when runtime config is unavailable.
}

const wsUrl = config.wsEndpoint || fallbackWsUrl;
elements.originValue.textContent = window.location.origin;
elements.wsUrlValue.textContent = wsUrl;

let socket: WebSocket | null = null;
let retryTimeout: ReturnType<typeof setTimeout> | null = null;
let retryCountdownInterval: ReturnType<typeof setInterval> | null = null;
let shouldStayConnected = true;

function createId() {
	return Math.random().toString(36).slice(2, 8);
}

function addLog(message: string, tone: LogEntry["tone"] = "neutral") {
	state.logs.unshift({
		id: createId(),
		at: new Date().toLocaleTimeString(),
		message,
		tone,
	});
	state.logs = state.logs.slice(0, LOG_LIMIT);
	render();
}

function clearRetryTimers() {
	if (retryTimeout) clearTimeout(retryTimeout);
	if (retryCountdownInterval) clearInterval(retryCountdownInterval);
	retryTimeout = null;
	retryCountdownInterval = null;
	state.retryInMs = 0;
}

function renderLogs() {
	elements.logList.innerHTML = state.logs
		.map(
			(entry) => `
				<li class="log-entry" data-tone="${entry.tone}">
					<span class="log-time">${entry.at}</span>
					<span class="log-message">${entry.message}</span>
				</li>
			`,
		)
		.join("");
}

function render() {
	elements.stateValue.textContent = state.connectionState;
	elements.attemptValue.textContent = String(state.attempt);
	elements.retryValue.textContent = state.retryInMs > 0 ? `${(state.retryInMs / 1000).toFixed(1)}s` : "-";
	elements.visibilityValue.textContent = state.visibility;
	elements.socketIdValue.textContent = state.socketId;
	elements.lifecycleValue.textContent = state.lastLifecycleEvent;
	elements.errorValue.textContent = state.lastError;
	elements.autoRetryToggle.checked = state.autoRetry;
	elements.cleanupToggle.checked = state.lifecycleCleanup;
	elements.sendButton.disabled = !socket || socket.readyState !== WebSocket.OPEN;
	(document.body as HTMLBodyElement).dataset.state = state.connectionState;
	renderLogs();
}

function scheduleReconnect(reason: string) {
	clearRetryTimers();

	if (!shouldStayConnected || !state.autoRetry) return;

	state.connectionState = "retrying";
	state.retryInMs = RETRY_DELAY_MS;
	addLog(`retry scheduled: ${reason}`, "warn");

	retryCountdownInterval = setInterval(() => {
		state.retryInMs = Math.max(state.retryInMs - 100, 0);
		render();
	}, 100);

	retryTimeout = setTimeout(() => {
		clearRetryTimers();
		void connect("scheduled retry");
	}, RETRY_DELAY_MS);
}

function closeSocket(reason: string) {
	clearRetryTimers();
	if (!socket) return;

	addLog(`closing socket: ${reason}`, "warn");
	socket.close(1000, reason);
	socket = null;
	state.connectionState = "closed";
	render();
}

function bindLifecycleHandlers() {
	const lifecycleClose = (eventName: string) => {
		state.lastLifecycleEvent = eventName;
		addLog(`lifecycle event: ${eventName}`, "warn");

		if (!state.lifecycleCleanup) {
			render();
			return;
		}

		if (eventName === "visibilitychange:hidden") {
			closeSocket("visibility hidden");
			render();
			return;
		}

		if (eventName === "visibilitychange:visible") {
			if (shouldStayConnected && (!socket || socket.readyState === WebSocket.CLOSED)) {
				void connect("visibility visible");
			}
			render();
			return;
		}

		closeSocket(eventName);
		render();
	};

	window.addEventListener("pagehide", () => lifecycleClose("pagehide"), true);
	window.addEventListener("beforeunload", () => lifecycleClose("beforeunload"), true);
	window.addEventListener("unload", () => lifecycleClose("unload"), true);
	document.addEventListener(
		"visibilitychange",
		() => {
			state.visibility = document.visibilityState;
			lifecycleClose(`visibilitychange:${document.visibilityState}`);
		},
		true,
	);
}

async function connect(reason: string) {
	if (socket && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)) {
		addLog(`connect skipped: socket already ${socket.readyState === WebSocket.OPEN ? "open" : "connecting"}`);
		return;
	}

	clearRetryTimers();

	state.attempt += 1;
	state.connectionState = "connecting";
	state.lastError = "-";
	addLog(`connect attempt ${state.attempt}: ${reason}`);
	render();

	socket = new WebSocket(wsUrl);

	socket.addEventListener("open", () => {
		state.connectionState = "open";
		state.lastError = "-";
		addLog("socket open", "good");
		render();
	});

	socket.addEventListener("message", (event) => {
		let payload = String(event.data);

		try {
			const parsed = JSON.parse(payload) as { type?: string; connectionId?: string; at?: string; payload?: string };
			if (parsed.connectionId) state.socketId = parsed.connectionId;
			payload = JSON.stringify(parsed);
		} catch {
			// Keep raw payload for the log.
		}

		addLog(`message: ${payload}`, "neutral");
		render();
	});

	socket.addEventListener("error", () => {
		state.lastError = "WebSocket error event";
		addLog("socket error", "bad");
		render();
	});

	socket.addEventListener("close", (event) => {
		const reasonText = event.reason || "no reason";
		state.connectionState = "closed";
		addLog(`socket close: code=${event.code} reason=${reasonText}`, event.wasClean ? "warn" : "bad");
		socket = null;
		render();
		scheduleReconnect(`close code ${event.code}`);
	});
}

elements.connectButton.addEventListener("click", () => {
	shouldStayConnected = true;
	void connect("manual connect");
});

elements.disconnectButton.addEventListener("click", () => {
	shouldStayConnected = false;
	closeSocket("manual disconnect");
});

elements.sendButton.addEventListener("click", () => {
	addLog("send disabled for connection-only repro", "warn");
});

elements.clearButton.addEventListener("click", () => {
	state.logs = [];
	render();
});

elements.autoRetryToggle.addEventListener("change", () => {
	state.autoRetry = elements.autoRetryToggle.checked;
	addLog(`auto retry ${state.autoRetry ? "enabled" : "disabled"}`);
	if (!state.autoRetry) clearRetryTimers();
	render();
});

elements.cleanupToggle.addEventListener("change", () => {
	state.lifecycleCleanup = elements.cleanupToggle.checked;
	addLog(`lifecycle cleanup ${state.lifecycleCleanup ? "enabled" : "disabled"}`);
	render();
});

bindLifecycleHandlers();
void connect("page load");
render();
