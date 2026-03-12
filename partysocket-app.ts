import { WebSocket } from "partysocket";

type ConnectionState = "idle" | "connecting" | "open" | "closing" | "closed" | "retrying";

type LogEntry = {
	id: string;
	at: string;
	message: string;
	tone: "neutral" | "good" | "warn" | "bad";
};

type PartySocketErrorEvent = Event & {
	message?: string;
};

type PartySocketCloseEvent = Event & {
	code: number;
	reason: string;
	wasClean: boolean;
};

type ReproConfig = {
	mode?: "plain";
	wsEndpoint?: string;
};

const LOG_LIMIT = 100;
const RECONNECT_DELAY_MS = 1200;

const state = {
	connectionState: "idle" as ConnectionState,
	retryCount: 0,
	readyState: "-" as string,
	socketId: "-",
	lastError: "-",
	lastLifecycleEvent: "-",
	lifecycleCleanup: true,
	shouldReconnect: "-",
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
	retryCountValue: getRequiredElement<HTMLElement>("#retry-count-value"),
	readyStateValue: getRequiredElement<HTMLElement>("#ready-state-value"),
	visibilityValue: getRequiredElement<HTMLElement>("#visibility-value"),
	socketIdValue: getRequiredElement<HTMLElement>("#socket-id-value"),
	lifecycleValue: getRequiredElement<HTMLElement>("#lifecycle-value"),
	originValue: getRequiredElement<HTMLElement>("#origin-value"),
	wsUrlValue: getRequiredElement<HTMLElement>("#ws-url-value"),
	reconnectValue: getRequiredElement<HTMLElement>("#reconnect-value"),
	shouldReconnectValue: getRequiredElement<HTMLElement>("#should-reconnect-value"),
	errorValue: getRequiredElement<HTMLElement>("#error-value"),
	debugValue: getRequiredElement<HTMLElement>("#debug-value"),
	logList: getRequiredElement<HTMLOListElement>("#log-list"),
	connectButton: getRequiredElement<HTMLButtonElement>("#connect-button"),
	reconnectButton: getRequiredElement<HTMLButtonElement>("#reconnect-button"),
	disconnectButton: getRequiredElement<HTMLButtonElement>("#disconnect-button"),
	sendButton: getRequiredElement<HTMLButtonElement>("#send-button"),
	clearButton: getRequiredElement<HTMLButtonElement>("#clear-button"),
	cleanupToggle: getRequiredElement<HTMLInputElement>("#cleanup-toggle"),
};

const fallbackWsUrl = `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/ws`;
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
elements.reconnectValue.textContent = "partysocket";
elements.debugValue.textContent = "enabled";

let socket: WebSocket | null = null;
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

function readyStateLabel(currentSocket: WebSocket | null) {
	if (!currentSocket) return "-";

	switch (currentSocket.readyState) {
		case currentSocket.CONNECTING:
			return "CONNECTING";
		case currentSocket.OPEN:
			return "OPEN";
		case currentSocket.CLOSING:
			return "CLOSING";
		case currentSocket.CLOSED:
			return "CLOSED";
		default:
			return String(currentSocket.readyState);
	}
}

function syncSocketState(currentSocket: WebSocket | null) {
	state.retryCount = currentSocket?.retryCount ?? 0;
	state.readyState = readyStateLabel(currentSocket);
	state.shouldReconnect = currentSocket ? String(currentSocket.shouldReconnect) : "-";
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
	syncSocketState(socket);
	elements.stateValue.textContent = state.connectionState;
	elements.retryCountValue.textContent = String(state.retryCount);
	elements.readyStateValue.textContent = state.readyState;
	elements.visibilityValue.textContent = state.visibility;
	elements.socketIdValue.textContent = state.socketId;
	elements.lifecycleValue.textContent = state.lastLifecycleEvent;
	elements.errorValue.textContent = state.lastError;
	elements.shouldReconnectValue.textContent = state.shouldReconnect;
	elements.cleanupToggle.checked = state.lifecycleCleanup;
	elements.sendButton.disabled = !socket || socket.readyState !== socket.OPEN;
	(document.body as HTMLBodyElement).dataset.state = state.connectionState;
	renderLogs();
}

function createSocket(reason: string) {
	const nextSocket = new WebSocket(wsUrl, undefined, {
		connectionTimeout: 4000,
		minReconnectionDelay: RECONNECT_DELAY_MS,
		maxReconnectionDelay: RECONNECT_DELAY_MS,
		reconnectionDelayGrowFactor: 1,
		debug: true,
		debugLogger: (...args: unknown[]) => {
			const message = args.map((value) => String(value)).join(" ");
			addLog(`partysocket: ${message}`);

			if (message.startsWith("connect")) {
				state.connectionState = nextSocket.retryCount > 0 ? "retrying" : "connecting";
				render();
			}
		},
	});

	socket = nextSocket;
	state.connectionState = "connecting";
	state.lastError = "-";
	addLog(`create partysocket client: ${reason}`, "neutral");
	render();

	nextSocket.addEventListener("open", () => {
		if (socket !== nextSocket) return;
		state.connectionState = "open";
		state.lastError = "-";
		addLog("socket open", "good");
		render();
	});

	nextSocket.addEventListener("message", (event) => {
		if (socket !== nextSocket) return;

		const messageEvent = event as MessageEvent;
		let payload = String(messageEvent.data);

		try {
			const parsed = JSON.parse(payload) as { connectionId?: string };
			if (parsed.connectionId) state.socketId = parsed.connectionId;
			payload = JSON.stringify(parsed);
		} catch {
			// Keep raw payload for the log.
		}

		addLog(`message: ${payload}`);
		render();
	});

	nextSocket.addEventListener("error", (event: PartySocketErrorEvent) => {
		if (socket !== nextSocket) return;

		const message = "message" in event && typeof event.message === "string" ? event.message : "WebSocket error event";
		state.lastError = message;
		state.connectionState = nextSocket.shouldReconnect ? "retrying" : "closed";
		addLog(`socket error: ${message}`, "bad");
		render();
	});

	nextSocket.addEventListener("close", (event) => {
		if (socket !== nextSocket) return;

		const closeEvent = event as PartySocketCloseEvent;
		const reasonText = closeEvent.reason || "no reason";
		state.connectionState = nextSocket.shouldReconnect ? "retrying" : "closed";
		addLog(`socket close: code=${closeEvent.code} reason=${reasonText}`, closeEvent.wasClean ? "warn" : "bad");
		render();
	});
}

function connect(reason: string) {
	shouldStayConnected = true;

	if (!socket) {
		createSocket(reason);
		return;
	}

	if (socket.readyState === socket.OPEN || socket.readyState === socket.CONNECTING) {
		addLog(`connect skipped: socket already ${readyStateLabel(socket).toLowerCase()}`);
		return;
	}

	state.connectionState = "connecting";
	state.lastError = "-";
	addLog(`manual reconnect: ${reason}`, "warn");
	socket.reconnect(1000, reason);
	render();
}

function closeSocket(reason: string, stayConnected: boolean) {
	if (!socket) return;

	shouldStayConnected = stayConnected;
	state.connectionState = "closing";
	addLog(`closing socket: ${reason}`, "warn");
	socket.close(1000, reason);
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
			closeSocket("visibility hidden", true);
			render();
			return;
		}

		if (eventName === "visibilitychange:visible") {
			if (shouldStayConnected && (!socket || socket.readyState === socket.CLOSED)) {
				connect("visibility visible");
			}
			render();
			return;
		}

		closeSocket(eventName, true);
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

elements.connectButton.addEventListener("click", () => {
	connect("manual connect");
});

elements.reconnectButton.addEventListener("click", () => {
	if (!socket) {
		console.log("create socket");
		createSocket("manual force reconnect");
		return;
	}

	console.log("reconnect socket");
	shouldStayConnected = true;
	state.connectionState = "retrying";
	addLog("force reconnect", "warn");
	socket.reconnect(1011, "manual reconnect");
	render();
});

elements.disconnectButton.addEventListener("click", () => {
	closeSocket("manual disconnect", false);
});

elements.sendButton.addEventListener("click", () => {
	addLog("send disabled for connection-only repro", "warn");
});

elements.clearButton.addEventListener("click", () => {
	state.logs = [];
	render();
});

elements.cleanupToggle.addEventListener("change", () => {
	state.lifecycleCleanup = elements.cleanupToggle.checked;
	addLog(`lifecycle cleanup ${state.lifecycleCleanup ? "enabled" : "disabled"}`);
	render();
});

bindLifecycleHandlers();
connect("page load");
render();
