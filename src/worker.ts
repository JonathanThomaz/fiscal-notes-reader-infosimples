import amqplib, { type ChannelModel, type ConfirmChannel, type ConsumeMessage } from 'amqplib';
import { validateResult, validateTask } from './contracts';
import type { QueryFn } from './infosimples';
import { READER_KEY } from './mapper';
import { runTask } from './reader';

export interface WorkerConfig {
  rabbitmqUrl: string;
  queue: string;
  resultsQueue: string;
  prefetch: number;
  readerVersion: string;
  query: QueryFn;
}

/** Logs em JSON; nunca incluem o conteúdo do QR nem o payload. */
export function log(
  level: 'info' | 'warn' | 'error',
  message: string,
  fields: Record<string, unknown> = {},
): void {
  if (process.env.LOG_SILENT === 'true') return;
  process.stdout.write(`${JSON.stringify({ level, message, time: new Date().toISOString(), ...fields })}\n`);
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Consome a fila do leitor (declarada pelo fiscal-notes-api), executa a tarefa e
 * publica o resultado em fiscal.results, com confirmação do broker antes do ack.
 */
export class InfosimplesWorker {
  private connection: ChannelModel | undefined;
  private channel: ConfirmChannel | undefined;
  private stopping = false;

  constructor(
    private readonly config: WorkerConfig,
    private readonly sleep: (ms: number) => Promise<void> = defaultSleep,
  ) {}

  async start(): Promise<void> {
    this.connection = await amqplib.connect(this.config.rabbitmqUrl);
    this.connection.on('error', (error: Error) =>
      log('error', 'Erro na conexão com o RabbitMQ', { error: error.message }),
    );
    await this.waitForQueue(this.connection);
    this.channel = await this.connection.createConfirmChannel();
    await this.channel.prefetch(this.config.prefetch);
    await this.channel.consume(this.config.queue, (message) => {
      if (message) void this.handle(message);
    });
    log('info', 'Worker consumindo', { queue: this.config.queue, prefetch: this.config.prefetch });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await this.connection?.close().catch(() => undefined);
  }

  /** Chamado quando a conexão cai sem que `stop()` tenha sido chamado. */
  onUnexpectedClose(listener: () => void): void {
    this.connection?.on('close', () => {
      if (!this.stopping) listener();
    });
  }

  /** A fila é declarada pela API na primeira publicação; até lá, espera. */
  private async waitForQueue(connection: ChannelModel): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      // checkQueue fecha o canal quando a fila não existe; por isso um canal por sondagem.
      const probe = await connection.createChannel();
      probe.on('error', () => undefined);
      try {
        await probe.checkQueue(this.config.queue);
        await probe.close();
        return;
      } catch {
        if (attempt === 1) log('info', 'Aguardando a API declarar a fila', { queue: this.config.queue });
        await this.sleep(Math.min(5_000, 500 * attempt));
      }
    }
  }

  private async handle(message: ConsumeMessage): Promise<void> {
    const channel = this.channel as ConfirmChannel;
    let body: unknown;
    try {
      body = JSON.parse(message.content.toString('utf8'));
    } catch {
      log('warn', 'Tarefa descartada: JSON inválido');
      channel.nack(message, false, false);
      return;
    }
    const validation = validateTask(body);
    if (!validation.ok || validation.task.reader_key !== READER_KEY) {
      log('warn', 'Tarefa descartada: fora do contrato ou de outro leitor', {
        errors: validation.ok ? 'reader_key' : validation.errors,
      });
      channel.nack(message, false, false);
      return;
    }

    const task = validation.task;
    try {
      const result = await runTask(task, {
        readerVersion: this.config.readerVersion,
        query: this.config.query,
        now: () => new Date(),
        sleep: this.sleep,
      });
      const check = validateResult(result);
      if (!check.ok) {
        throw new Error(`Resultado fora do contrato: ${check.errors}`);
      }
      channel.sendToQueue(this.config.resultsQueue, Buffer.from(JSON.stringify(result)), {
        persistent: true,
        contentType: 'application/json',
        messageId: task.attempt_id,
      });
      await channel.waitForConfirms();
      channel.ack(message);
      log('info', 'Tarefa concluída', { attempt_id: task.attempt_id, status: result.status });
    } catch (error) {
      log('error', 'Falha ao processar tarefa; devolvendo à fila', {
        attempt_id: task.attempt_id,
        error: (error as Error).message,
      });
      channel.nack(message, false, true);
    }
  }
}
