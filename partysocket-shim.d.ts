declare module "partysocket" {
	export type WebSocketOptions = {
		WebSocket?: typeof globalThis.WebSocket;
		maxReconnectionDelay?: number;
		minReconnectionDelay?: number;
		reconnectionDelayGrowFactor?: number;
		minUptime?: number;
		connectionTimeout?: number;
		maxRetries?: number;
		maxEnqueuedMessages?: number;
		startClosed?: boolean;
		debug?: boolean;
		debugLogger?: (...args: unknown[]) => void;
	};

	export class WebSocket extends EventTarget {
		constructor(url: string, protocols?: string | string[] | null, options?: WebSocketOptions);
		static readonly CONNECTING: 0;
		static readonly OPEN: 1;
		static readonly CLOSING: 2;
		static readonly CLOSED: 3;
		readonly CONNECTING: 0;
		readonly OPEN: 1;
		readonly CLOSING: 2;
		readonly CLOSED: 3;
		readonly url: string;
		readonly readyState: number;
		readonly retryCount: number;
		readonly shouldReconnect: boolean;
		binaryType: BinaryType;
		bufferedAmount: number;
		close(code?: number, reason?: string): void;
		reconnect(code?: number, reason?: string): void;
		send(data: string | ArrayBuffer | Blob | ArrayBufferView): void;
	}

	export default WebSocket;
}

declare module "partysocket/ws" {
	export { WebSocket as default } from "partysocket";
}
