import type { CanonicalDocumentV1, CanonicalItemV1 } from './contracts';
import type { InfosimplesNfce } from './infosimples';

export const READER_KEY = 'infosimples';
export const NORMALIZER_VERSION = '1.0.0';

/** Campos que a consulta resumida de MG não traz. */
const ALWAYS_MISSING = [
  'issuer.address',
  'totals.discount',
  'totals.other_charges',
  'items.gtin',
  'items.ncm',
  'items.cfop',
  'items.discount',
  'payment',
];

const STATUS: Record<string, string> = {
  AUTORIZADA: 'authorized',
  CANCELADA: 'cancelled',
  DENEGADA: 'denied',
};

/** "19/10/2026 17:56:33" (horário de Brasília) → ISO 8601 com -03:00. */
export function parseBrDateTime(value: string | undefined): string | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}):(\d{2})$/.exec(value?.trim() ?? '');
  return m ? `${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:${m[6]}-03:00` : null;
}

/** Número da API → decimal em string, sem ruído de ponto flutuante. */
export function decimal(value: number | undefined, places = 2): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value.toFixed(places);
}

function quantity(value: number | undefined): string | null {
  const fixed = decimal(value, 4);
  return fixed === null ? null : fixed.replace(/\.?0+$/, '');
}

export function toCanonical(
  nfce: InfosimplesNfce,
  ctx: { accessKey: string; readerVersion: string; retrievedAt: Date },
): CanonicalDocumentV1 {
  const items: CanonicalItemV1[] = (nfce.produtos_servicos ?? []).map((p, index) => ({
    line_number: p.numero && p.numero > 0 ? p.numero : index + 1,
    description: p.descricao?.trim() || null,
    gtin: null,
    sku: null,
    ncm: null,
    cfop: null,
    unit: p.unidade_comercial?.trim() || null,
    quantity: quantity(p.quantidade),
    unit_price: decimal(p.normalizado_valor_unitario),
    discount: null,
    total: decimal(p.normalizado_valor),
    brand: null,
    category: null,
  }));

  const invoice = decimal(nfce.valores?.normalizado_valor_total_servico);
  const sumCents = (nfce.produtos_servicos ?? []).reduce(
    (acc, p) => acc + Math.round((p.normalizado_valor ?? 0) * 100),
    0,
  );
  const products = items.length > 0 ? (sumCents / 100).toFixed(2) : null;

  const warnings: string[] = [];
  if (invoice !== null && products !== null && invoice !== products) {
    warnings.push(`Soma dos itens (${products}) difere do total da nota (${invoice}).`);
  }
  const keyFromApi = (nfce.chave_acesso ?? '').replace(/\D/g, '');
  if (keyFromApi && keyFromApi !== ctx.accessKey) {
    warnings.push('Chave devolvida pela API difere da chave consultada.');
  }

  const issuer = {
    name: nfce.emitente?.razao_social?.trim() || null,
    tax_id: nfce.emitente?.normalizado_cnpj?.replace(/\D/g, '') || null,
    state_registration: nfce.emitente?.inscricao_estadual?.replace(/\D/g, '') || null,
    address: null,
  };
  const issuedAt = parseBrDateTime(nfce.nfce?.normalizado_datahora_emissao);
  const situacao = nfce.situacao_atual?.trim().toUpperCase();

  const present: string[] = [];
  const missing = [...ALWAYS_MISSING];
  const check = (name: string, value: unknown) => (value ? present : missing).push(name);
  check('issuer.name', issuer.name);
  check('issuer.tax_id', issuer.tax_id);
  check('issuer.state_registration', issuer.state_registration);
  check('issued_at', issuedAt);
  check('status', situacao);
  check('totals.invoice', invoice);
  check('items', items.length);

  return {
    schema_version: '1.0',
    document: {
      document_type: 'NFC-e',
      model: String(nfce.nfce?.modelo ?? ctx.accessKey.slice(20, 22)),
      access_key: ctx.accessKey,
      // O conteúdo do QR não sai do worker (pode conter hash e parâmetros do emitente).
      qr_url: null,
      issuer,
      issued_at: issuedAt,
      status: situacao ? (STATUS[situacao] ?? situacao.toLowerCase()) : null,
      currency: 'BRL',
      totals: { products, discount: null, other_charges: null, invoice, paid: null },
      items,
    },
    provenance: {
      reader_id: READER_KEY,
      reader_version: ctx.readerVersion,
      normalizer_version: NORMALIZER_VERSION,
      retrieved_at: ctx.retrievedAt.toISOString(),
      source_url: null,
    },
    quality: { fields_present: present, fields_missing: missing, warnings },
  };
}
