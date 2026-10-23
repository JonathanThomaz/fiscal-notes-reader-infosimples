import { buildTask } from '../test/fixtures';
import { errorBody, fakeQuery, successBody } from '../test/infosimples-fixtures';
import { validateResult } from './contracts';
import type { QueryFn } from './infosimples';
import { parseBrDateTime } from './mapper';
import { runTask } from './reader';

const deps = (query: QueryFn, sleeps: number[] = []) => ({
  readerVersion: '0.1.0',
  query,
  now: () => new Date(),
  sleep: (ms: number) => {
    sleeps.push(ms);
    return Promise.resolve();
  },
});

describe('leitor infosimples', () => {
  it('normaliza a resposta 200 no canônico', async () => {
    const task = buildTask();
    const key = task.input.access_key as string;
    const result = await runTask(task, deps(fakeQuery([successBody(key)])));

    expect(validateResult(result)).toEqual({ ok: true });
    expect(result.status).toBe('success');
    const doc = result.normalized!.document;
    expect(doc).toMatchObject({
      document_type: 'NFC-e',
      model: '65',
      access_key: key,
      qr_url: null,
      issued_at: '2026-10-19T17:56:33-03:00',
      status: 'authorized',
      issuer: { name: 'MERCADO EXEMPLO LTDA', tax_id: '12345678000199', state_registration: '0012345670011' },
      totals: { products: '18.97', invoice: '18.97', paid: null },
    });
    expect(doc.items[1]).toMatchObject({
      line_number: 2,
      unit: 'KG',
      quantity: '0.875',
      unit_price: '4.56',
      total: '3.99',
      gtin: null,
    });
    expect(result.normalized!.quality.warnings).toEqual([]);
    expect(result.normalized!.quality.fields_missing).toEqual(
      expect.arrayContaining(['items.gtin', 'items.ncm', 'payment']),
    );
    expect(result.raw?.content_type).toContain('application/json');
  });

  it('avisa quando a soma dos itens não bate com o total', async () => {
    const task = buildTask();
    const body = successBody(task.input.access_key as string);
    body.data![0].valores!.normalizado_valor_total_servico = 20;
    const result = await runTask(task, deps(fakeQuery([body])));
    expect(result.normalized!.quality.warnings[0]).toContain('difere do total');
  });

  it.each([
    [601, 'failed', false],
    [603, 'failed', false],
    [608, 'invalid_input', false],
    [605, 'timeout', true],
    [609, 'provider_error', true],
    [699, 'provider_error', false],
  ])('código %i vira %s (retryable=%s)', async (code, status, retryable) => {
    const result = await runTask(
      buildTask({ limits: { timeout_ms: 1000, max_attempts: 1, backoff_ms: 0 } }),
      deps(fakeQuery([errorBody(code)])),
    );
    expect(validateResult(result)).toEqual({ ok: true });
    expect(result.status).toBe(status);
    expect(result.error).toMatchObject({ code: `infosimples_${code}`, retryable });
    expect(result.error!.message_redacted).not.toContain('3126');
  });

  it('repete só erros não cobrados, com backoff', async () => {
    const calls: string[] = [];
    const sleeps: number[] = [];
    const task = buildTask({ limits: { timeout_ms: 1000, max_attempts: 3, backoff_ms: 10 } });
    const result = await runTask(
      task,
      deps(fakeQuery([errorBody(605), successBody(task.input.access_key as string)], calls), sleeps),
    );
    expect(result.status).toBe('success');
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([10]);

    const once: string[] = [];
    await runTask(
      buildTask({ limits: { timeout_ms: 1000, max_attempts: 3, backoff_ms: 10 } }),
      deps(fakeQuery([errorBody(608)], once)),
    );
    expect(once).toHaveLength(1);
  });

  it('não consulta notas fora de MG nem sem chave', async () => {
    const calls: string[] = [];
    const sp = buildTask();
    sp.input.issuer_uf = 'SP';
    expect((await runTask(sp, deps(fakeQuery([successBody()], calls)))).status).toBe('not_supported');

    const noKey = await runTask(buildTask({ key: null }), deps(fakeQuery([successBody()], calls)));
    expect(noKey.status).toBe('invalid_input');
    expect(validateResult(noKey)).toEqual({ ok: true });
    expect(calls).toHaveLength(0);
  });

  it('trata JSON inválido e falha de rede', async () => {
    const limits = { timeout_ms: 1000, max_attempts: 1, backoff_ms: 0 };
    expect((await runTask(buildTask({ limits }), deps(fakeQuery(['<html>'])))).status).toBe('parse_error');
    const net = await runTask(buildTask({ limits }), deps(fakeQuery([new Error('ECONNRESET')])));
    expect(net).toMatchObject({
      status: 'provider_error',
      error: { code: 'network_error', retryable: true },
    });
  });

  it('converte data e hora de Brasília', () => {
    expect(parseBrDateTime('01/02/2026 03:04:05')).toBe('2026-02-01T03:04:05-03:00');
    expect(parseBrDateTime('inválida')).toBeNull();
  });
});
