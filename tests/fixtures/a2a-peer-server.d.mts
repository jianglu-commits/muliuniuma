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
}

export interface A2APeerServer {
  baseUrl: string;
  port: number;
  requests: A2APeerRequest[];
  close(): Promise<void>;
}

export declare function startA2APeerServer(options?: A2APeerServerOptions): Promise<A2APeerServer>;
export declare function startHangingServer(): Promise<A2APeerServer>;
