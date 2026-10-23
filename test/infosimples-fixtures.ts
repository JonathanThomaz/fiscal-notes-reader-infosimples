import type { HttpReply, InfosimplesResponse, QueryFn } from '../src/infosimples';

/**
 * Resposta 200 no formato real da Infosimples (teste de 23/10/2026), com dados
 * fictícios: nenhum CPF, CNPJ ou chave reais.
 */
export function successBody(accessKey = '31261012345678000199650010000012341000012340'): InfosimplesResponse {
  const masked = accessKey.replace(
    /^(\d{2})(\d{4})(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})(\d{2})(\d{3})(\d{3})(\d{3})(\d{3})(\d{3})(\d{3})(\d{4})$/,
    '$1-$2/$3.$4.$5/$6-$7-$8-$9-$10.$11.$12-$13.$14.$15',
  );
  return {
    code: 200,
    code_message: 'A requisição foi processada com sucesso.',
    errors: [],
    header: { billable: true, price: '0.24', elapsed_time_in_milliseconds: 74000 },
    data_count: 1,
    data: [
      {
        chave_acesso: masked,
        situacao_atual: 'AUTORIZADA',
        emitente: {
          normalizado_cnpj: '12345678000199',
          razao_social: 'MERCADO EXEMPLO LTDA',
          inscricao_estadual: '001234567.00-11',
          uf: 'MG',
        },
        nfce: { modelo: 65, normalizado_datahora_emissao: '19/10/2026 17:56:33' },
        valores: { normalizado_valor_total_servico: 18.97 },
        produtos_servicos: [
          {
            numero: 1,
            descricao: 'ARROZ 5KG',
            quantidade: 1.0,
            unidade_comercial: 'UN',
            normalizado_valor_unitario: 10.99,
            normalizado_valor: 10.99,
          },
          {
            numero: 2,
            descricao: 'BANANA PRATA',
            quantidade: 0.875,
            unidade_comercial: 'KG',
            normalizado_valor_unitario: 4.56,
            normalizado_valor: 3.99,
          },
          {
            numero: 3,
            descricao: 'LEITE 1L',
            quantidade: 1.0,
            unidade_comercial: 'UN',
            normalizado_valor_unitario: 3.99,
            normalizado_valor: 3.99,
          },
        ],
      },
    ],
  };
}

export function errorBody(code: number, message = `Erro ${code}`): InfosimplesResponse {
  return { code, code_message: message, errors: ['Nfce 3126... não é válido'], data_count: 0, data: [] };
}

export function reply(body: InfosimplesResponse | string, httpStatus = 200): HttpReply {
  return {
    httpStatus,
    contentType: 'application/json; charset=utf-8',
    body: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

/** Devolve as respostas em sequência (repete a última) e registra as chaves consultadas. */
export function fakeQuery(bodies: (InfosimplesResponse | string | Error)[], calls: string[] = []): QueryFn {
  return (accessKey) => {
    const next = bodies[Math.min(calls.length, bodies.length - 1)];
    calls.push(accessKey);
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(reply(next));
  };
}
