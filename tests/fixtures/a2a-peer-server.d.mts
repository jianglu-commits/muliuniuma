export interface A2APeerRequestBody {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: {
    message?: {
      messageId?: string;
      role?: string;
      parts?: { text?: string; mediaType?: string }[];
    };
  };
}

export interface A2APeerRequest {
  url: string;
  method: string;
  headers: Record<string, string | string[] | undefined>;
  body: A2APeerRequestBody | undefined;
}

export interface A2APeerServerOptions {
  replyText?: string;
  peerName?: string;
  /** 卡片照常返回，但调用请求永不回包。 */
  hangOnCall?: boolean;
}

export interface A2APeerServer {
  baseUrl: string;
  port: number;
  requests: A2APeerRequest[];
  close(): Promise<void>;
  /** close() 是否已被调用过。 */
  isClosed(): boolean;
}

export declare function startA2APeerServer(options?: A2APeerServerOptions): Promise<A2APeerServer>;
export declare function startHangingServer(): Promise<A2APeerServer>;
