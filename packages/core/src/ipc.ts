/**
 * IPC protocol — JSON-RPC 2.0 over Node IPC channel.
 *
 * Used for parent ↔ child communication in process-isolated plugins.
 * Supports request/response with correlation IDs and timeouts,
 * plus fire-and-forget notifications.
 */

import { randomUUID } from "crypto";
import type { ChildProcess } from "child_process";

// ---------------------------------------------------------------------------
// Message types — JSON-RPC 2.0
// ---------------------------------------------------------------------------

/** JSON-RPC 2.0 request (expects a response) */
export interface IpcRequest {
  jsonrpc: "2.0";
  id: string;
  method: string;
  params?: unknown;
}

/** JSON-RPC 2.0 success/error response */
export interface IpcResponse {
  jsonrpc: "2.0";
  id: string;
  result?: unknown;
  error?: IpcError;
}

/** JSON-RPC 2.0 error object */
export interface IpcError {
  code: number;
  message: string;
  data?: unknown;
}

/** JSON-RPC 2.0 notification (fire-and-forget, no id) */
export interface IpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

/** Any message that can travel over the IPC channel */
export type IpcMessage = IpcRequest | IpcResponse | IpcNotification;

// ---------------------------------------------------------------------------
// Standard error codes
// ---------------------------------------------------------------------------

export const IPC_ERRORS = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  /** Custom: request timed out waiting for response */
  TIMEOUT: -32000,
  /** Custom: tool handler threw an error */
  TOOL_ERROR: -32001,
  /** Custom: plugin is in degraded state */
  DEGRADED: -32002,
} as const;

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

export function isIpcRequest(msg: unknown): msg is IpcRequest {
  return isObject(msg) && msg["jsonrpc"] === "2.0" && typeof msg["id"] === "string" && typeof msg["method"] === "string";
}

export function isIpcResponse(msg: unknown): msg is IpcResponse {
  return isObject(msg) && msg["jsonrpc"] === "2.0" && typeof msg["id"] === "string" && !("method" in msg);
}

export function isIpcNotification(msg: unknown): msg is IpcNotification {
  return isObject(msg) && msg["jsonrpc"] === "2.0" && typeof msg["method"] === "string" && !("id" in msg);
}

// ---------------------------------------------------------------------------
// Message constructors
// ---------------------------------------------------------------------------

export function createRequest(method: string, params?: unknown): IpcRequest {
  return { jsonrpc: "2.0", id: randomUUID(), method, params };
}

export function createResponse(id: string, result: unknown): IpcResponse {
  return { jsonrpc: "2.0", id, result };
}

export function createErrorResponse(id: string, code: number, message: string, data?: unknown): IpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message, data } };
}

export function createNotification(method: string, params?: unknown): IpcNotification {
  return { jsonrpc: "2.0", method, params };
}

// ---------------------------------------------------------------------------
// IpcChannel — typed wrapper over process.send / on('message')
// ---------------------------------------------------------------------------

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/** Handler for incoming requests (must return a result or throw) */
export type RequestHandler = (method: string, params: unknown) => Promise<unknown>;

/** Handler for incoming notifications */
export type NotificationHandler = (method: string, params: unknown) => void;

/**
 * Bidirectional IPC channel over Node's built-in IPC.
 *
 * Works identically on both sides:
 * - Parent creates IpcChannel(childProcess)
 * - Child creates IpcChannel(process)
 */
export class IpcChannel {
  private pending = new Map<string, PendingRequest>();
  private requestHandler: RequestHandler | null = null;
  private notificationHandler: NotificationHandler | null = null;
  private closed = false;

  constructor(
    private target: ChildProcess | NodeJS.Process,
    private defaultTimeout = 30_000,
  ) {
    // Listen for messages from the other side
    target.on("message", (msg: unknown) => {
      if (this.closed) return;
      this.handleMessage(msg);
    });
  }

  /** Register handler for incoming requests */
  onRequest(handler: RequestHandler): void {
    this.requestHandler = handler;
  }

  /** Register handler for incoming notifications */
  onNotification(handler: NotificationHandler): void {
    this.notificationHandler = handler;
  }

  /**
   * Send a request and wait for the correlated response.
   * Rejects on timeout or if the remote returns an error.
   */
  async request<T = unknown>(method: string, params?: unknown, timeout?: number): Promise<T> {
    if (this.closed) throw new Error("IPC channel is closed");

    const req = createRequest(method, params);
    const ms = timeout ?? this.defaultTimeout;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(req.id);
        reject(new Error(`IPC request "${method}" timed out after ${ms}ms`));
      }, ms);
      timer.unref();

      this.pending.set(req.id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });

      this.send(req);
    });
  }

  /** Send a notification (fire-and-forget) */
  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    this.send(createNotification(method, params));
  }

  /** Send a response to a received request */
  respond(id: string, result: unknown): void {
    if (this.closed) return;
    this.send(createResponse(id, result));
  }

  /** Send an error response to a received request */
  respondError(id: string, code: number, message: string, data?: unknown): void {
    if (this.closed) return;
    this.send(createErrorResponse(id, code, message, data));
  }

  /** Close the channel, reject all pending requests */
  close(): void {
    if (this.closed) return;
    this.closed = true;

    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error("IPC channel closed"));
      this.pending.delete(id);
    }
  }

  // ── Internal ──

  private send(msg: IpcMessage): void {
    if (typeof this.target.send !== "function") return;
    this.target.send(msg);
  }

  private handleMessage(msg: unknown): void {
    if (isIpcResponse(msg)) {
      // Correlate with a pending request
      const pending = this.pending.get(msg.id);
      if (!pending) return; // Stale or duplicate response — ignore
      clearTimeout(pending.timer);
      this.pending.delete(msg.id);

      if (msg.error) {
        const err = new Error(msg.error.message);
        (err as Error & { code: number }).code = msg.error.code;
        pending.reject(err);
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    if (isIpcRequest(msg)) {
      // Dispatch to request handler, send response back
      if (!this.requestHandler) {
        this.respondError(msg.id, IPC_ERRORS.METHOD_NOT_FOUND, `No handler for "${msg.method}"`);
        return;
      }
      this.requestHandler(msg.method, msg.params)
        .then((result) => this.respond(msg.id, result))
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          this.respondError(msg.id, IPC_ERRORS.INTERNAL_ERROR, message);
        });
      return;
    }

    if (isIpcNotification(msg)) {
      this.notificationHandler?.(msg.method, msg.params);
    }
  }
}
