import homepage from "./index.html";
import partysocketPage from "./partysocket.html";

const uiPort = Number(process.env.PORT || 3100);
const runMode = process.env.REPRO_MODE === "same-port" ? "same-port" : "split-port";
const wsPort = runMode === "same-port" ? uiPort : Number(process.env.WS_PORT || 3001);

type SocketData = {
	id: string;
	connectedAt: number;
};

const activeSockets = new Map<string, Bun.ServerWebSocket<SocketData>>();
const textDecoder = new TextDecoder();

function toText(payload: string | Buffer | ArrayBuffer | Uint8Array) {
	if (typeof payload === "string") return payload;
	if (payload instanceof ArrayBuffer) return textDecoder.decode(new Uint8Array(payload));
	return textDecoder.decode(payload);
}

function getSocketProtocol(req: Request) {
	return req.headers.get("x-forwarded-proto") === "https" ? "wss" : "ws";
}

function getSocketEndpoints(hostname: string, protocol: string) {
	const plainEndpoint = `${protocol}://${hostname}:${wsPort}/ws`;

	return { plainEndpoint };
}

function createUiResponse(req: Request) {
	const url = new URL(req.url);

	if (url.pathname === "/health") {
		return Response.json({
			ok: true,
			mode: "plain",
			topology: runMode,
			appPort: uiPort,
			wsPort: wsPort,
			timestamp: new Date().toISOString(),
		});
	}

	if (url.pathname === "/__repro-config") {
		const protocol = getSocketProtocol(req);
		const { plainEndpoint } = getSocketEndpoints(url.hostname, protocol);
		return Response.json(
			{
				mode: "plain",
				topology: runMode,
				wsEndpoint: plainEndpoint,
			},
			{
				headers: {
					"cache-control": "no-store",
				},
			},
		);
	}

	return null;
}

function handleWebSocketRequest(req: Request, serverInstance: Bun.Server<SocketData>) {
	const url = new URL(req.url);

	if (url.pathname === "/health") {
		return Response.json({
			ok: true,
			mode: "plain",
			topology: runMode,
			activeConnections: activeSockets.size,
			wsEndpoint: getSocketEndpoints(url.hostname, getSocketProtocol(req)).plainEndpoint,
			timestamp: new Date().toISOString(),
		});
	}

	if (url.pathname !== "/ws") {
		return new Response("Not found", { status: 404 });
	}

	const requestId = crypto.randomUUID().slice(0, 8);
	const requestMeta = {
		origin: req.headers.get("origin"),
		upgrade: req.headers.get("upgrade"),
		connection: req.headers.get("connection"),
		secWebSocketVersion: req.headers.get("sec-websocket-version"),
		secWebSocketExtensions: req.headers.get("sec-websocket-extensions"),
		userAgent: req.headers.get("user-agent"),
	};

	console.log(`[ws:${requestId}] incoming request`, requestMeta);

	const upgraded = serverInstance.upgrade(req, {
		data: {
			id: requestId,
			connectedAt: Date.now(),
		},
	});

	console.log(`[ws:${requestId}] upgrade result`, upgraded);

	return upgraded ? undefined : new Response("Cannot upgrade request", { status: 500 });
}

const websocketHandler: Bun.WebSocketHandler<SocketData> = {
	idleTimeout: 5,
	open(socket) {
		activeSockets.set(socket.data.id, socket);
		const payload = {
			type: "server:open",
			connectionId: socket.data.id,
			at: new Date().toISOString(),
			activeConnections: activeSockets.size,
		};

		console.log(`[ws:${socket.data.id}] open`, payload);
		socket.send(JSON.stringify(payload));
	},
	message(socket, payload) {
		const text = toText(payload);
		const message = {
			type: "server:echo",
			connectionId: socket.data.id,
			at: new Date().toISOString(),
			activeConnections: activeSockets.size,
			payload: text,
		};

		console.log(`[ws:${socket.data.id}] message`, message);
		socket.send(JSON.stringify(message));
	},
	close(socket, code, reason) {
		activeSockets.delete(socket.data.id);
		console.log(`[ws:${socket.data.id}] close`, {
			code,
			reason,
			activeConnections: activeSockets.size,
		});
	},
};

const uiServer = Bun.serve<SocketData>({
	hostname: "0.0.0.0",
	port: uiPort,
	routes: {
		"/": homepage,
		"/index.html": homepage,
		"/partysocket": partysocketPage,
		"/partysocket.html": partysocketPage,
	},
	fetch(req, serverInstance) {
		const uiResponse = createUiResponse(req);
		if (uiResponse) return uiResponse;

		if (runMode === "same-port") {
			return handleWebSocketRequest(req, serverInstance);
		}

		return new Response("Not found", { status: 404 });
	},
	websocket: websocketHandler,
});

const plainWsServer =
	runMode === "split-port"
		? Bun.serve<SocketData>({
				hostname: "0.0.0.0",
				port: wsPort,
				fetch(req, serverInstance) {
					return handleWebSocketRequest(req, serverInstance);
				},
				websocket: websocketHandler,
			})
		: null;

console.log(`WebSocket refresh repro UI running (plain mode)`);
console.log(`Topology: ${runMode}`);
console.log(`Local:    http://localhost:${uiServer.port}`);
console.log(`Network:  http://<your-lan-ip>:${uiServer.port}`);
console.log(`Socket:   ws://<same-host>:${wsPort}/ws`);

if (plainWsServer) {
	console.log(`WS server is running on its own port: ${plainWsServer.port}`);
} else {
	console.log(`WS server is sharing the UI port: ${uiServer.port}`);
}
