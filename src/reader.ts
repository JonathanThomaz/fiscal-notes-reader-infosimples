import { createHash } from 'node:crypto';
import type { ReaderResultV1, ReaderTaskV1, ResultStatus } from './contracts';
import type { HttpReply, InfosimplesResponse, QueryFn } from './infosimples';
import { READER_KEY, toCanonical } from './mapper';

interface Outcome {
  status: ResultStatus;
  httpStatus: number | null;
  error: ReaderResultV1['error'];
  raw: HttpReply | null;
  normalized: ReaderResultV1['normalized'];
}

/**
 * Códigos da Infosimples (API v2) → status do reader-result.v1.
 * Só repete os não cobrados (600, 605, 609, 610); ver ADR 0010.
 */
const CODES: Record<number, { status: ResultStatus; retryable: boolean }> = {
  600: { status: 'provider_error', retryable: true },
  601: { status: 'failed', retryable: false },
  602: { status: 'failed', retryable: false },
  603: { status: 'failed', retryable: false },
  604: { status: 'invalid_input', retryable: false },
  605: { status: 'timeout', retryable: true },
  606: { status: 'invalid_input', retryable: false },
  607: { status: 'invalid_input', retryable: false },
  608: { status: 'invalid_input', retryable: false },
  609: { status: 'provider_error', retryable: true },
  610: { status: 'provider_error', retryable: true },
};

function failure(
  status: ResultStatus,
  code: string,
  message: string,
  retryable: boolean,
  raw: HttpReply | null = null,
): Outcome {
  return {
    status,
    httpStatus: raw?.httpStatus ?? null,
    error: { code, message_redacted: message, retryable },
    raw,
    normalized: null,
  };
}

export interface RunDeps {
  readerVersion: string;
  query: QueryFn;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
}

/** Só NFC-e de MG (cUF 31). Devolve o motivo de recusa ou null. */
export function unsupportedReason(task: ReaderTaskV1): string | null {
  const key = task.input.access_key;
  const uf = task.input.issuer_uf ?? (key?.startsWith('31') ? 'MG' : null);
  if (uf !== 'MG') return 'Leitor cobre só MG.';
  if (key && key.slice(20, 22) !== '65') return 'Leitor cobre só NFC-e (modelo 65).';
  return null;
}

async function attemptOnce(
  task: ReaderTaskV1,
  accessKey: string,
  deps: RunDeps,
  deadline: number,
): Promise<Outcome> {
  const remaining = deadline - deps.now().getTime();
  if (remaining <= 0) return failure('timeout', 'deadline_exceeded', 'Prazo da tarefa esgotado.', false);

  let reply: HttpReply;
  try {
    reply = await deps.query(accessKey, AbortSignal.timeout(remaining));
  } catch (error) {
    const aborted = (error as Error).name === 'TimeoutError' || (error as Error).name === 'AbortError';
    return aborted
      ? failure('timeout', 'deadline_exceeded', 'Prazo da tarefa esgotado durante a consulta.', false)
      : failure('provider_error', 'network_error', 'Falha de rede ao chamar a Infosimples.', true);
  }

  let body: InfosimplesResponse;
  try {
    body = JSON.parse(reply.body.toString('utf8')) as InfosimplesResponse;
  } catch {
    return failure(
      'parse_error',
      'invalid_json',
      `Resposta não é JSON (HTTP ${reply.httpStatus}).`,
      false,
      reply,
    );
  }

  if (body.code === 200) {
    const nfce = body.data?.[0];
    if (!nfce)
      return { status: 'empty', httpStatus: reply.httpStatus, error: null, raw: reply, normalized: null };
    return {
      status: 'success',
      httpStatus: reply.httpStatus,
      error: null,
      raw: reply,
      normalized: toCanonical(nfce, {
        accessKey,
        readerVersion: deps.readerVersion,
        retrievedAt: deps.now(),
      }),
    };
  }

  const known = CODES[body.code] ?? { status: 'provider_error' as const, retryable: false };
  // code_message é texto fixo da API; `errors` pode ecoar parâmetros e fica fora.
  return failure(
    known.status,
    `infosimples_${body.code}`,
    body.code_message ?? `Código ${body.code}`,
    known.retryable,
    reply,
  );
}

/**
 * Executa a tarefa com as retentativas de `limits` (só erros não cobrados, backoff
 * exponencial, sem passar do `deadline`) e devolve um único resultado final.
 */
export async function runTask(task: ReaderTaskV1, deps: RunDeps): Promise<ReaderResultV1> {
  const startedAt = deps.now();
  const deadline = new Date(task.deadline).getTime();
  const maxAttempts = task.limits?.max_attempts ?? 1;
  const backoffMs = task.limits?.backoff_ms ?? 0;
  const accessKey = task.input.access_key;

  let outcome: Outcome;
  const reason = unsupportedReason(task);
  if (reason) {
    outcome = { status: 'not_supported', httpStatus: null, error: null, raw: null, normalized: null };
  } else if (!accessKey || !/^\d{44}$/.test(accessKey)) {
    outcome = failure('invalid_input', 'no_access_key', 'Tarefa sem chave de acesso de 44 dígitos.', false);
  } else {
    outcome = await attemptOnce(task, accessKey, deps, deadline);
    for (let attempt = 2; attempt <= maxAttempts && outcome.error?.retryable; attempt++) {
      const delay = backoffMs * 2 ** (attempt - 2);
      if (deps.now().getTime() + delay >= deadline) break;
      await deps.sleep(delay);
      outcome = await attemptOnce(task, accessKey, deps, deadline);
    }
  }

  return {
    contract_version: 'reader-result.v1',
    attempt_id: task.attempt_id,
    reader_key: READER_KEY,
    reader_version: deps.readerVersion,
    status: outcome.status,
    started_at: startedAt.toISOString(),
    finished_at: deps.now().toISOString(),
    http_status: outcome.httpStatus,
    error: outcome.error,
    raw: outcome.raw
      ? {
          content_type: outcome.raw.contentType,
          size_bytes: outcome.raw.body.length,
          sha256: createHash('sha256').update(outcome.raw.body).digest('hex'),
          body_base64: outcome.raw.body.toString('base64'),
        }
      : null,
    normalized: outcome.normalized,
  };
}
