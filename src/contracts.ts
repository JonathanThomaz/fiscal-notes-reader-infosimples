import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import canonicalSchema from './contracts/schemas/canonical-document.v1.schema.json';
import resultSchema from './contracts/schemas/reader-result.v1.schema.json';
import taskSchema from './contracts/schemas/reader-task.v1.schema.json';

// Tipos escritos à mão espelhando os JSON Schemas do workspace (ADR 0008).

export interface ReaderTaskV1 {
  contract_version: 'reader-task.v1';
  attempt_id: string;
  document_id: string;
  run_id: string;
  reader_key: string;
  reader_version: string;
  attempt_number: number;
  input: {
    qr_content: string;
    access_key: string | null;
    document_type: 'unknown' | 'nfe' | 'nfce' | 'other';
    model: string | null;
    issuer_uf: string | null;
  };
  deadline: string;
  limits?: { timeout_ms: number; max_attempts: number; backoff_ms: number };
  published_at: string;
}

export type ResultStatus =
  | 'success'
  | 'empty'
  | 'not_supported'
  | 'not_found'
  | 'blocked'
  | 'timeout'
  | 'invalid_input'
  | 'parse_error'
  | 'provider_error'
  | 'failed';

export interface CanonicalItemV1 {
  line_number: number;
  description: string | null;
  gtin: string | null;
  sku: string | null;
  ncm: string | null;
  cfop: string | null;
  unit: string | null;
  quantity: string | null;
  unit_price: string | null;
  discount: string | null;
  total: string | null;
  brand: string | null;
  category: string | null;
}

export interface CanonicalDocumentV1 {
  schema_version: '1.0';
  document: {
    document_type: 'NF-e' | 'NFC-e' | 'other' | 'unknown' | null;
    model: string | null;
    access_key: string | null;
    qr_url: string | null;
    issuer: {
      name: string | null;
      tax_id: string | null;
      state_registration: string | null;
      address: string | null;
    };
    issued_at: string | null;
    status: string | null;
    currency: string | null;
    totals: {
      products: string | null;
      discount: string | null;
      other_charges: string | null;
      invoice: string | null;
      paid: string | null;
    };
    items: CanonicalItemV1[];
  };
  provenance: {
    reader_id: string;
    reader_version: string;
    normalizer_version: string;
    retrieved_at: string;
    source_url: string | null;
  };
  quality: { fields_present: string[]; fields_missing: string[]; warnings: string[] };
}

export interface ReaderResultV1 {
  contract_version: 'reader-result.v1';
  attempt_id: string;
  reader_key: string;
  reader_version: string;
  status: ResultStatus;
  started_at: string | null;
  finished_at: string;
  http_status: number | null;
  error: { code: string; message_redacted: string | null; retryable: boolean } | null;
  raw: { content_type: string | null; size_bytes: number; sha256: string; body_base64: string } | null;
  normalized: CanonicalDocumentV1 | null;
}

const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
addFormats(ajv);
ajv.addSchema(canonicalSchema, 'canonical-document.v1.schema.json');
ajv.addSchema(taskSchema, 'reader-task.v1.schema.json');
ajv.addSchema(resultSchema, 'reader-result.v1.schema.json');

const taskValidator = ajv.getSchema('reader-task.v1.schema.json') as ValidateFunction<ReaderTaskV1>;
const resultValidator = ajv.getSchema('reader-result.v1.schema.json') as ValidateFunction<ReaderResultV1>;

export function validateTask(
  value: unknown,
): { ok: true; task: ReaderTaskV1 } | { ok: false; errors: string } {
  return taskValidator(value)
    ? { ok: true, task: value }
    : { ok: false, errors: ajv.errorsText(taskValidator.errors) };
}

export function validateResult(value: unknown): { ok: true } | { ok: false; errors: string } {
  return resultValidator(value)
    ? { ok: true }
    : { ok: false, errors: ajv.errorsText(resultValidator.errors) };
}
