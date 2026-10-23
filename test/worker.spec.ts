import amqplib, { type Channel, type ChannelModel } from 'amqplib';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import type { ReaderResultV1 } from '../src/contracts';
import { InfosimplesWorker } from '../src/worker';
import { buildTask } from './fixtures';
import { fakeQuery, successBody } from './infosimples-fixtures';

// Mesmos argumentos que o fiscal-notes-api usa ao declarar as filas (src/messaging/topology.ts).
const QUEUE = 'reader.infosimples.v1';
const RESULTS = 'fiscal.results';

describe('worker (RabbitMQ real)', () => {
  let container: StartedTestContainer;
  let url: string;
  let connection: ChannelModel;
  let channel: Channel;
  let worker: InfosimplesWorker;

  beforeAll(async () => {
    process.env.LOG_SILENT = 'true';
    container = await new GenericContainer('rabbitmq:3.13-alpine')
      .withExposedPorts(5672)
      .withWaitStrategy(Wait.forLogMessage('Server startup complete'))
      .start();
    url = `amqp://guest:guest@${container.getHost()}:${container.getMappedPort(5672)}`;
    connection = await amqplib.connect(url);
    channel = await connection.createChannel();

    // O worker espera a fila existir: inicia antes da declaração, como acontece em produção.
    worker = new InfosimplesWorker(
      {
        rabbitmqUrl: url,
        queue: QUEUE,
        resultsQueue: RESULTS,
        prefetch: 2,
        readerVersion: '0.1.0',
        query: fakeQuery([successBody()]),
      },
      (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 50))),
    );
    const started = worker.start();

    await channel.assertExchange('fiscal.dlx', 'direct', { durable: true });
    await channel.assertQueue('reader.dead', { durable: true, arguments: { 'x-queue-type': 'quorum' } });
    await channel.bindQueue('reader.dead', 'fiscal.dlx', 'reader.dead');
    await channel.assertQueue(RESULTS, { durable: true, arguments: { 'x-queue-type': 'quorum' } });
    await channel.assertQueue(QUEUE, {
      durable: true,
      arguments: {
        'x-queue-type': 'quorum',
        'x-dead-letter-exchange': 'fiscal.dlx',
        'x-dead-letter-routing-key': 'reader.dead',
        'x-delivery-limit': 5,
      },
    });
    await started;
  });

  afterAll(async () => {
    await worker?.stop();
    await connection?.close();
    await container?.stop();
  });

  async function nextResult(): Promise<ReaderResultV1> {
    for (let i = 0; i < 100; i++) {
      const message = await channel.get(RESULTS, { noAck: true });
      if (message) return JSON.parse(message.content.toString()) as ReaderResultV1;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('nenhum resultado publicado');
  }

  it('consome a tarefa e publica um resultado no contrato', async () => {
    const task = buildTask();
    channel.sendToQueue(QUEUE, Buffer.from(JSON.stringify(task)));
    const result = await nextResult();
    expect(result).toMatchObject({
      attempt_id: task.attempt_id,
      status: 'success',
      reader_key: 'infosimples',
    });
    expect(result.normalized?.document.items.length).toBeGreaterThan(0);
  });

  it('envia para a fila morta tarefas fora do contrato', async () => {
    channel.sendToQueue(QUEUE, Buffer.from(JSON.stringify({ contract_version: 'reader-task.v1' })));
    for (let i = 0; i < 50; i++) {
      if ((await channel.checkQueue('reader.dead')).messageCount > 0) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect((await channel.checkQueue('reader.dead')).messageCount).toBe(1);
  });
});
