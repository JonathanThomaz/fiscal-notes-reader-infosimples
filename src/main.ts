import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createQuery } from './infosimples';
import { log, InfosimplesWorker, type WorkerConfig } from './worker';

// dist/main.js → ../package.json (raiz do repositório).
const { version } = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as {
  version: string;
};

function loadConfig(): WorkerConfig {
  const rabbitmqUrl = process.env.RABBITMQ_URL;
  if (!rabbitmqUrl || !/^amqps?:\/\//.test(rabbitmqUrl)) {
    throw new Error('RABBITMQ_URL ausente ou não é uma URL amqp://');
  }
  const prefetch = Number(process.env.PREFETCH ?? 2);
  if (!Number.isInteger(prefetch) || prefetch < 1) {
    throw new Error('PREFETCH deve ser um inteiro >= 1');
  }
  const token = process.env.INFOSIMPLES_TOKEN;
  if (!token) {
    throw new Error('INFOSIMPLES_TOKEN ausente');
  }
  const timeoutSeconds = Number(process.env.INFOSIMPLES_TIMEOUT_S ?? 300);
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1) {
    throw new Error('INFOSIMPLES_TIMEOUT_S deve ser um inteiro >= 1');
  }
  return {
    rabbitmqUrl,
    queue: process.env.READER_QUEUE ?? 'reader.infosimples.v1',
    resultsQueue: process.env.RESULTS_QUEUE ?? 'fiscal.results',
    prefetch,
    readerVersion: version,
    query: createQuery(token, timeoutSeconds),
  };
}

/** Reconecta com backoff se a conexão cair; encerra limpo em SIGINT/SIGTERM. */
async function main(): Promise<void> {
  const config = loadConfig();
  let worker: InfosimplesWorker | undefined;
  let stopping = false;

  const connect = async (attempt = 1): Promise<void> => {
    if (stopping) return;
    try {
      worker = new InfosimplesWorker(config);
      await worker.start();
      worker.onUnexpectedClose(() => {
        log('warn', 'Conexão perdida; reconectando');
        void connect();
      });
    } catch (error) {
      const delay = Math.min(30_000, 1_000 * 2 ** (attempt - 1));
      log('warn', 'Falha ao conectar; nova tentativa', { error: (error as Error).message, delay_ms: delay });
      setTimeout(() => void connect(attempt + 1), delay);
    }
  };

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      stopping = true;
      log('info', 'Encerrando', { signal });
      void (worker?.stop() ?? Promise.resolve()).then(() => process.exit(0));
    });
  }

  await connect();
}

main().catch((error: Error) => {
  log('error', 'Falha fatal', { error: error.message });
  process.exit(1);
});
