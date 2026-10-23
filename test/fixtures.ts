import type { ReaderTaskV1 } from '../src/contracts';

/** Dígito verificador módulo 11 da chave de acesso. */
function checkDigit(first43: string): number {
  let sum = 0;
  let weight = 2;
  for (let i = first43.length - 1; i >= 0; i--) {
    sum += Number(first43[i]) * weight;
    weight = weight === 9 ? 2 : weight + 1;
  }
  const remainder = sum % 11;
  return remainder < 2 ? 0 : 11 - remainder;
}

export function buildAccessKey(number = 1234, model = '65'): string {
  const first43 = `312610${'12345678000199'}${model}001${String(number).padStart(9, '0')}1${'00001234'}`;
  return first43 + checkDigit(first43);
}

let sequence = 0;

export function buildTask(
  overrides: { qr?: string; key?: string | null; limits?: ReaderTaskV1['limits'] } = {},
): ReaderTaskV1 {
  sequence++;
  const key = overrides.key === undefined ? buildAccessKey(sequence) : overrides.key;
  const id = `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
  return {
    contract_version: 'reader-task.v1',
    attempt_id: id,
    document_id: id,
    run_id: id,
    reader_key: 'infosimples',
    reader_version: '0.1.0',
    attempt_number: 1,
    input: {
      qr_content:
        overrides.qr ??
        `https://portalsped.fazenda.mg.gov.br/portalnfce/sistema/qrcode.xhtml?p=${key ?? ''}|2|1|1|ABC`,
      access_key: key,
      document_type: 'nfce',
      model: '65',
      issuer_uf: 'MG',
    },
    deadline: new Date(Date.now() + 60_000).toISOString(),
    limits: overrides.limits ?? { timeout_ms: 1000, max_attempts: 2, backoff_ms: 10 },
    published_at: new Date().toISOString(),
  };
}
