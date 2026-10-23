export const API_URL = 'https://api.infosimples.com/api/v2/consultas/sefaz/mg/nfce-resumida';

/** Subconjunto da resposta da Infosimples usado pelo leitor (API v2). */
export interface InfosimplesResponse {
  code: number;
  code_message?: string;
  errors?: string[];
  header?: { price?: string | null; billable?: boolean; elapsed_time_in_milliseconds?: number };
  data_count?: number;
  data?: InfosimplesNfce[];
}

export interface InfosimplesNfce {
  chave_acesso?: string;
  situacao_atual?: string;
  emitente?: {
    normalizado_cnpj?: string;
    razao_social?: string;
    inscricao_estadual?: string;
    uf?: string;
  };
  nfce?: { modelo?: number; normalizado_datahora_emissao?: string };
  valores?: { normalizado_valor_total_servico?: number };
  produtos_servicos?: {
    numero?: number;
    descricao?: string;
    quantidade?: number;
    unidade_comercial?: string;
    normalizado_valor_unitario?: number;
    normalizado_valor?: number;
  }[];
}

export interface HttpReply {
  httpStatus: number;
  contentType: string | null;
  body: Buffer;
}

export type QueryFn = (accessKey: string, signal: AbortSignal) => Promise<HttpReply>;

/** Cliente HTTP. Nunca registra o token, a chave nem o corpo. */
export function createQuery(token: string, timeoutSeconds: number, fetchImpl: typeof fetch = fetch): QueryFn {
  return async (accessKey, signal) => {
    const response = await fetchImpl(API_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token, nfce: accessKey, timeout: String(timeoutSeconds) }),
      signal,
    });
    return {
      httpStatus: response.status,
      contentType: response.headers.get('content-type'),
      body: Buffer.from(await response.arrayBuffer()),
    };
  };
}
