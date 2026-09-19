import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { mintDashboardToken } from '../helpers/auth.js';

// #382, remaining gap: an imported custom endpoint can carry the models it
// serves. Chat ids go through the same registration POST /custom runs;
// ids that look like embedding models go through the embeddings path, probing
// the endpoint for dimensions only when the model is not already on record.

const realFetch = globalThis.fetch;

let dashToken = '';

async function post(app: Express, path: string, body: unknown) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as { port: number };
  const res = await realFetch(`http://127.0.0.1:${addr.port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${dashToken}` },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: json as any };
}

async function previewFile(app: Express, filename: string, content: string) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as { port: number };
  const form = new FormData();
  form.append('files', new Blob([content], { type: 'text/plain' }), filename);
  const res = await realFetch(`http://127.0.0.1:${addr.port}/api/keys/preview`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${dashToken}` },
    body: form,
  });
  const json = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: json as any };
}

function customModels() {
  return getDb().prepare(
    "SELECT model_id, supports_tools, supports_vision, key_id, endpoint_scope FROM models WHERE platform = 'custom' ORDER BY model_id",
  ).all() as Array<{ model_id: string; supports_tools: number; supports_vision: number; key_id: number; endpoint_scope: string }>;
}

describe('POST /api/keys/import-selected — model lists (#382)', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();
  });

  beforeEach(() => {
    const db = getDb();
    db.prepare("DELETE FROM fallback_config WHERE model_db_id IN (SELECT id FROM models WHERE platform = 'custom')").run();
    db.prepare("DELETE FROM models WHERE platform = 'custom'").run();
    db.prepare('DELETE FROM api_keys').run();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('registers chat models bound to the imported endpoint, with the parsed flags', async () => {
    const { status, body } = await post(app, '/api/keys/import-selected', {
      keys: [{
        keyName: 'My Relay',
        keyValue: 'sk-relay-123',
        platform: 'custom',
        baseUrl: 'https://relay.example.com/v1',
        models: [
          { id: 'llama3' },
          { id: 'qwen3', supportsTools: true, supportsVision: true },
        ],
      }],
    });

    expect(status).toBe(200);
    expect(body.imported).toBe(1);
    expect(body.modelsRegistered).toBe(2);
    expect(body.errors).toEqual([]);

    const keyRow = getDb().prepare("SELECT id FROM api_keys WHERE platform = 'custom'").get() as { id: number };
    expect(customModels()).toEqual([
      // Flags left unset take the registration defaults (tools 1, vision 0).
      expect.objectContaining({ model_id: 'llama3', supports_tools: 1, supports_vision: 0, key_id: keyRow.id, endpoint_scope: 'https://relay.example.com/v1' }),
      expect.objectContaining({ model_id: 'qwen3', supports_tools: 1, supports_vision: 1, key_id: keyRow.id }),
    ]);
  });

  it('ignores model lists on catalog-platform rows', async () => {
    const { body } = await post(app, '/api/keys/import-selected', {
      keys: [{
        keyName: 'GROQ_API_KEY',
        keyValue: 'gsk-test-123',
        platform: 'groq',
        models: [{ id: 'llama3' }],
      }],
    });

    expect(body.imported).toBe(1);
    expect(body.modelsRegistered).toBe(0);
    expect(customModels()).toEqual([]);
  });

  it('carries models from /preview so the dialog can pass them back', async () => {
    const env = [
      'CUSTOM_1_BASE_URL=https://relay.example.com/v1',
      'CUSTOM_1_KEY=sk-relay-123',
      'CUSTOM_1_MODELS=llama3,qwen3-TOOLS',
    ].join('\n');

    const { status, body } = await previewFile(app, 'keys.env', env);
    expect(status).toBe(200);
    const custom = body.keys.find((k: any) => k.detectedPlatform === 'custom');
    expect(custom).toBeTruthy();
    expect(custom.models).toEqual([{ id: 'llama3' }, { id: 'qwen3', supportsTools: true }]);
  });
});
