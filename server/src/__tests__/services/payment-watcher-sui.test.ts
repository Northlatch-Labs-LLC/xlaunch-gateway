import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initDb, getDb, setSetting, getSetting } from '../../db/index.js';
import { pollPayments, normalizeSuiAddress } from '../../services/payment-watcher.js';

/*
  Regression cover for a payment that arrived and was never credited.

  On 9 September 2026 a customer sent 1 SUI to the treasury. It settled on
  mainnet, from a wallet registered to their account, and the portal showed
  them nothing. Two faults, and the second made the first permanent:

    1. the watcher compared `change.coinType.repr` to the literal
       `'0x2::sui::SUI'`, while the chain answers the fully expanded
       `0x0000…0002::sui::SUI` — so no SUI transfer ever matched;
    2. the cursor advanced whenever the query returned, so the transaction was
       paged over and no later poll could reach it again.

  Every fixture below is the real GraphQL response for that transaction,
  digest ETMWrDN6v4mk8fbqsy2W8YLHMS4TqxbsCNaBgEPwEdZv.
*/

const TREASURY = '0x8539945639191e1749b60c1cd56ada185569b69b1ca7a9e5d6c7915d60c06084';
const SENDER = '0xda784b6c20c5995f6b719a20a26eddee5ec971c8ecec890e61c8b4634dd1715d';
const DIGEST = 'ETMWrDN6v4mk8fbqsy2W8YLHMS4TqxbsCNaBgEPwEdZv';
const CURSOR = 'KAE6CAgAEJrO6fIV';

/** The coin type exactly as mainnet spells it. */
const CHAIN_SUI_TYPE =
  '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI';

function page(coinType: string, cursor: string | null = CURSOR) {
  return {
    data: {
      transactions: {
        pageInfo: { endCursor: cursor, hasNextPage: false },
        nodes: [{
          digest: DIGEST,
          sender: { address: SENDER },
          effects: {
            timestamp: '2026-09-09T07:20:00.000Z',
            balanceChanges: {
              nodes: [
                { owner: { address: TREASURY }, amount: '1000000000', coinType: { repr: coinType } },
                { owner: { address: SENDER }, amount: '-995209400', coinType: { repr: coinType } },
              ],
            },
          },
        }],
      },
    },
  };
}

function replyWith(body: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), {
    status: 200, headers: { 'content-type': 'application/json' },
  })));
}

beforeEach(() => {
  initDb(':memory:');
  setSetting('payments_watcher_enabled', 'true');
  setSetting('payments_sui_treasury_address', TREASURY);
  setSetting('billing_sui_usd_rate', '1');
  getDb().prepare('INSERT INTO customers (email, password_hash) VALUES (?, ?)')
    .run('payer@example.com', 'x');
  getDb().prepare('INSERT INTO customer_wallets (customer_id, chain, address) VALUES (?, ?, ?)')
    .run(1, 'sui', SENDER);
});

afterEach(() => { vi.unstubAllGlobals(); });

describe('payment watcher: Sui', () => {
  it('credits a transfer whose coin type arrives fully expanded', async () => {
    replyWith(page(CHAIN_SUI_TYPE));
    const counts = await pollPayments();

    expect(counts.sui).toBe(1);
    const row = getDb().prepare('SELECT * FROM payments WHERE tx_hash = ?').get(DIGEST) as
      { status: string; customer_id: number; amount_atomic: string; usd_micros: number };
    expect(row.status).toBe('credited');
    expect(row.customer_id).toBe(1);
    expect(row.amount_atomic).toBe('1000000000');
    // 1 SUI at $1 is a whole dollar, in micro-dollars.
    expect(row.usd_micros).toBe(1_000_000);
  });

  it('posts the credit to the ledger the portal reads', async () => {
    replyWith(page(CHAIN_SUI_TYPE));
    await pollPayments();
    const entries = getDb().prepare('SELECT * FROM billing_ledger WHERE customer_id = ?').all(1);
    expect(entries).toHaveLength(1);
  });

  it('advances the cursor once the page is accounted for', async () => {
    replyWith(page(CHAIN_SUI_TYPE));
    await pollPayments();
    expect(getSetting('payments_sui_cursor')).toBe(CURSOR);
  });

  it('holds the cursor when money arrives in a coin it cannot read', async () => {
    // An arrival at the treasury this watcher has no rule for. It must stay in
    // view: paging past it is how the original payment became unreachable.
    replyWith(page('0x2::wal::WAL'));
    await pollPayments();

    expect(getSetting('payments_sui_cursor')).toBeUndefined();
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM payments').get()).toEqual({ n: 0 });
  });

  it('matches a wallet the customer registered in short form', async () => {
    // Sui prints leading zeros; a person typing the address often does not.
    getDb().prepare('DELETE FROM customer_wallets').run();
    getDb().prepare('INSERT INTO customer_wallets (customer_id, chain, address) VALUES (?, ?, ?)')
      .run(1, 'sui', normalizeSuiAddress('0xda784b6c20c5995f6b719a20a26eddee5ec971c8ecec890e61c8b4634dd1715d'));
    replyWith(page(CHAIN_SUI_TYPE));
    await pollPayments();
    const row = getDb().prepare('SELECT status FROM payments WHERE tx_hash = ?').get(DIGEST) as { status: string };
    expect(row.status).toBe('credited');
  });
});

describe('normalizeSuiAddress', () => {
  it('makes the two spellings of one address the same string', () => {
    expect(normalizeSuiAddress('0x2')).toBe(`0x${'0'.repeat(63)}2`);
    expect(normalizeSuiAddress(TREASURY)).toBe(TREASURY);
    expect(normalizeSuiAddress(TREASURY.toUpperCase().replace('0X', '0x'))).toBe(TREASURY);
  });
});
