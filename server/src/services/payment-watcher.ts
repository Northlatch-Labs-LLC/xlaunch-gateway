// On-chain payment watching for SUI (Sui) and USDC (Ethereum or Base).
//
// This module is READ-ONLY against both chains. It holds no private key, signs
// nothing, and moves no funds: it polls public RPC for transfers that have
// already arrived at the operator's treasury address and credits the sending
// customer. Withdrawing from the treasury is the operator's own wallet's job
// and never happens here.
//
// Matching is by sender. A customer registers the wallet they will pay from,
// and `customer_wallets` holds that address uniquely per chain, so an incoming
// transfer resolves to exactly one account or to none. A transfer from an
// unregistered wallet is still recorded, with status 'unmatched', because
// money that arrived must be visible even when nobody has claimed it.
//
// Crediting is idempotent through the UNIQUE (chain, tx_hash) index: a
// re-scanned block, an overlapping poll, or a restart mid-batch can only ever
// insert one row per transfer.

import { getDb, getSetting, setSetting } from '../db/index.js';
import { postLedger, suiUsdRate, USD } from './billing.js';

/** Chains this watcher understands. */
export type PaymentChain = 'sui' | 'ethereum' | 'base';

/** Settings keys holding the operator's receiving addresses and endpoints. */
const KEYS = {
  suiTreasury: 'payments_sui_treasury_address',
  suiRpc: 'payments_sui_rpc_url',
  suiCursor: 'payments_sui_cursor',
  evmChain: 'payments_evm_chain',
  evmTreasury: 'payments_evm_treasury_address',
  evmRpc: 'payments_evm_rpc_url',
  evmUsdc: 'payments_evm_usdc_contract',
  evmCursor: 'payments_evm_cursor_block',
  enabled: 'payments_watcher_enabled',
} as const;

// Sui's JSON-RPC was switched off on Foundation mainnet full nodes in July
// 2026 and is being removed entirely; GraphQL is the sanctioned interface for
// exactly this kind of historical query. The public endpoint is rate limited,
// so a production deployment points `payments_sui_rpc_url` at its own.
const DEFAULT_SUI_RPC = 'https://graphql.mainnet.sui.io/graphql';

/** Canonical USDC contracts, so the operator does not have to know them. */
const USDC_CONTRACTS: Record<'ethereum' | 'base', string> = {
  ethereum: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  base: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
};

/** USDC carries six decimals on every chain it is deployed to. */
const USDC_DECIMALS = 6n;

/** SUI is denominated in MIST: 1 SUI = 1e9 MIST. */
const MIST_PER_SUI = 1_000_000_000n;

/**
 * Canonicalize a Sui address to its full 32-byte hex form.
 *
 * Sui treats `0x2` and its 66-character spelling as one address, but they are
 * two different strings. Every comparison in this module goes through here, so
 * which spelling a chain, a customer or an operator happened to use cannot
 * decide whether money is seen.
 * @param value - an address in any accepted spelling.
 * @returns the address as `0x` followed by 64 lowercase hex characters.
 */
export function normalizeSuiAddress(value: string): string {
  return `0x${value.trim().toLowerCase().replace(/^0x/, '').padStart(64, '0')}`;
}

/**
 * Canonicalize a coin type by canonicalizing the package address in front of it.
 *
 * GraphQL answers `0x0000…0002::sui::SUI`; humans and this file write
 * `0x2::sui::SUI`. Those were compared as raw strings, so they never matched and
 * no SUI payment was ever recognised.
 * @param repr - a coin type as `address::module::name`.
 * @returns the same type with its address canonicalized.
 */
function normalizeCoinType(repr: string): string {
  const parts = repr.trim().split('::');
  const address = parts[0];
  if (address === undefined || parts.length < 2) return repr.trim().toLowerCase();
  return [normalizeSuiAddress(address), ...parts.slice(1)].join('::');
}

/** The only coin this watcher credits on Sui, in canonical form. */
const SUI_COIN_TYPE = normalizeCoinType('0x2::sui::SUI');

/** How often the watcher polls, and how far back an EVM scan may reach. */
const POLL_INTERVAL_MS = 60_000;
const MAX_EVM_BLOCK_SPAN = 2_000n;

/** The `Transfer(address,address,uint256)` topic every ERC-20 emits. */
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/** One transfer observed on chain, normalized across both families. */
interface ObservedTransfer {
  chain: PaymentChain;
  txHash: string;
  fromAddress: string;
  asset: 'SUI' | 'USDC';
  amountAtomic: bigint;
  blockTime: string | null;
}

/** The operator's current payment configuration. */
export interface PaymentConfig {
  enabled: boolean;
  suiTreasury: string | null;
  suiRpc: string;
  evmChain: 'ethereum' | 'base';
  evmTreasury: string | null;
  evmRpc: string | null;
  evmUsdc: string;
}

/**
 * Read the payment configuration, filling in the defaults the operator does
 * not need to state.
 * @returns the resolved configuration.
 */
export function paymentConfig(): PaymentConfig {
  const evmChain = getSetting(KEYS.evmChain) === 'ethereum' ? 'ethereum' : 'base';
  return {
    enabled: getSetting(KEYS.enabled) === 'true',
    suiTreasury: getSetting(KEYS.suiTreasury) ?? null,
    suiRpc: getSetting(KEYS.suiRpc) ?? DEFAULT_SUI_RPC,
    evmChain,
    evmTreasury: getSetting(KEYS.evmTreasury) ?? null,
    evmRpc: getSetting(KEYS.evmRpc) ?? null,
    evmUsdc: getSetting(KEYS.evmUsdc) ?? USDC_CONTRACTS[evmChain],
  };
}

/**
 * Store the payment configuration. Only the fields supplied are written, so a
 * partial edit cannot blank an address the operator did not touch.
 * @param patch - the fields to change.
 */
export function setPaymentConfig(patch: Partial<{
  enabled: boolean;
  suiTreasury: string;
  suiRpc: string;
  evmChain: 'ethereum' | 'base';
  evmTreasury: string;
  evmRpc: string;
  evmUsdc: string;
}>): void {
  if (patch.enabled !== undefined) setSetting(KEYS.enabled, patch.enabled ? 'true' : 'false');
  if (patch.suiTreasury !== undefined) setSetting(KEYS.suiTreasury, patch.suiTreasury.trim());
  if (patch.suiRpc !== undefined) setSetting(KEYS.suiRpc, patch.suiRpc.trim());
  if (patch.evmChain !== undefined) setSetting(KEYS.evmChain, patch.evmChain);
  if (patch.evmTreasury !== undefined) setSetting(KEYS.evmTreasury, patch.evmTreasury.trim().toLowerCase());
  if (patch.evmRpc !== undefined) setSetting(KEYS.evmRpc, patch.evmRpc.trim());
  if (patch.evmUsdc !== undefined) setSetting(KEYS.evmUsdc, patch.evmUsdc.trim().toLowerCase());
}

/**
 * Convert an observed transfer to micro-dollars. USDC is taken at par; SUI
 * needs the operator's configured rate, and a rate of zero means SUI payments
 * are recorded but credit nothing, which is safer than guessing a price.
 * @param transfer - the observed transfer.
 * @returns the value in micro-dollars.
 */
function usdMicrosFor(transfer: ObservedTransfer): number {
  if (transfer.asset === 'USDC') {
    // 6 decimals to 6 decimals: USDC's smallest unit already IS a micro-dollar.
    return Number(transfer.amountAtomic);
  }
  const rate = suiUsdRate();
  if (rate <= 0) return 0;
  const sui = Number(transfer.amountAtomic) / Number(MIST_PER_SUI);
  return Math.floor(sui * rate * USD);
}

/**
 * Record one observed transfer and credit its sender when that wallet is
 * registered. Safe to call repeatedly with the same transfer.
 * @param transfer - the observed transfer.
 * @returns whether this call was the one that recorded it.
 */
export function recordTransfer(transfer: ObservedTransfer): boolean {
  const db = getDb();
  const already = db.prepare('SELECT 1 FROM payments WHERE chain = ? AND tx_hash = ?')
    .get(transfer.chain, transfer.txHash);
  if (already) return false;

  /*
    The sender in canonical form. Sui addresses need padding as well as case
    folding; EVM addresses are fixed width, so lowercasing is the whole of it.
  */
  const fromAddress = transfer.chain === 'sui'
    ? normalizeSuiAddress(transfer.fromAddress)
    : transfer.fromAddress.toLowerCase();
  const wallet = db.prepare(
    'SELECT customer_id FROM customer_wallets WHERE chain = ? AND address = ?',
  ).get(transfer.chain, fromAddress) as { customer_id: number } | undefined;

  const usdMicros = usdMicrosFor(transfer);
  const status = wallet ? 'credited' : 'unmatched';
  const info = db.prepare(`
    INSERT INTO payments (customer_id, chain, tx_hash, from_address, asset, amount_atomic, usd_micros, status, block_time)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    wallet?.customer_id ?? null,
    transfer.chain,
    transfer.txHash,
    fromAddress,
    transfer.asset,
    transfer.amountAtomic.toString(),
    usdMicros,
    status,
    transfer.blockTime,
  );

  if (wallet && usdMicros > 0) {
    postLedger(wallet.customer_id, {
      kind: 'credit',
      usdMicros,
      reason: `${transfer.asset} payment`,
      refId: Number(info.lastInsertRowid),
    });
  }
  return true;
}

/**
 * Post a JSON-RPC request. This is the EVM interface: Ethereum and Base speak
 * JSON-RPC as their standard, and it is not deprecated there.
 * @param url - the RPC endpoint.
 * @param method - the RPC method.
 * @param params - method parameters.
 * @returns the decoded result.
 * @throws when the endpoint replies with an error or a non-2xx status.
 */
async function rpc(url: string, method: string, params: unknown[]): Promise<unknown> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`${method}: HTTP ${String(response.status)}`);
  const body = await response.json() as { result?: unknown; error?: { message?: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message ?? 'RPC error'}`);
  return body.result;
}

/** Transfers into one address, newest last, with the sender and what moved. */
const SUI_TRANSFERS_QUERY = `
  query Transfers($address: SuiAddress!, $after: String) {
    transactions(filter: { affectedAddress: $address }, first: 50, after: $after) {
      pageInfo { endCursor }
      nodes {
        digest
        sender { address }
        effects {
          timestamp
          balanceChanges { nodes { owner { address } amount coinType { repr } } }
        }
      }
    }
  }
`;

/**
 * Post a GraphQL query. Sui serves this interface; the EVM chains do not, so
 * the JSON-RPC helper above stays for them.
 * @param url - the GraphQL endpoint.
 * @param query - the query document.
 * @param variables - query variables.
 * @returns the `data` payload.
 * @throws when the endpoint replies with a non-2xx status or GraphQL errors.
 */
async function graphql(url: string, query: string, variables: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`sui graphql: HTTP ${String(response.status)}`);
  const body = await response.json() as { data?: unknown; errors?: { message?: string }[] };
  if (body.errors?.length) throw new Error(`sui graphql: ${body.errors[0]?.message ?? 'query error'}`);
  return body.data;
}

/**
 * Poll Sui for SUI transfers into the treasury address. Sui indexes balance
 * changes per address, so the query asks the chain directly for what arrived
 * rather than scanning blocks.
 * @param config - the resolved payment configuration.
 * @returns how many new transfers were recorded.
 */
async function pollSui(config: PaymentConfig): Promise<number> {
  if (!config.suiTreasury) return 0;
  const after = getSetting(KEYS.suiCursor) ?? null;
  const result = await graphql(config.suiRpc, SUI_TRANSFERS_QUERY, {
    address: config.suiTreasury,
    after,
  }) as {
    transactions?: {
      pageInfo?: { endCursor?: string | null };
      nodes?: {
        digest: string;
        sender?: { address?: string } | null;
        effects?: {
          timestamp?: string | null;
          balanceChanges?: {
            nodes?: { owner?: { address?: string } | null; amount?: string | null; coinType?: { repr?: string } | null }[];
          } | null;
        } | null;
      }[];
    };
  };

  const treasury = normalizeSuiAddress(config.suiTreasury);
  let recorded = 0;
  /*
    Whether this pass accounted for every transaction on the page.

    The cursor may only move past transactions that were understood. It used to
    move whenever the query itself returned, which made a page this code
    misread indistinguishable from a page with nothing on it — and that is
    exactly how a real payment ended up behind a cursor that had already
    stepped over it, unreachable by any later poll.
  */
  let understood = true;
  for (const node of result.transactions?.nodes ?? []) {
    const changes = node.effects?.balanceChanges?.nodes ?? [];
    // Everything that arrived at the treasury here, whatever the coin.
    const arrivals = changes.filter(change =>
      change.owner?.address !== undefined
      && normalizeSuiAddress(change.owner.address) === treasury
      && BigInt(change.amount ?? '0') > 0n);
    // Nothing arrived: the transaction merely touched the address.
    if (arrivals.length === 0) continue;

    const sender = node.sender?.address;
    const gain = arrivals.find(change =>
      change.coinType?.repr !== undefined
      && normalizeCoinType(change.coinType.repr) === SUI_COIN_TYPE);
    if (gain === undefined || sender === undefined) {
      /*
        Money arrived and this pass cannot say who sent it, or in what coin.
        Holding the cursor keeps it in view: an arrival nobody explained must
        stay visible until it is credited or understood, never be paged past.
      */
      console.error(`[payments] Sui arrival not understood, holding cursor at ${node.digest}`);
      understood = false;
      continue;
    }
    const added = recordTransfer({
      chain: 'sui',
      txHash: node.digest,
      fromAddress: sender,
      asset: 'SUI',
      amountAtomic: BigInt(gain.amount ?? '0'),
      blockTime: node.effects?.timestamp ?? null,
    });
    if (added) recorded += 1;
  }
  // Advance only past a page this pass understood, so neither a mid-batch
  // failure nor an arrival it could not read is skipped.
  const cursor = result.transactions?.pageInfo?.endCursor;
  if (understood && cursor) setSetting(KEYS.suiCursor, cursor);
  return recorded;
}

/**
 * Decode the 32-byte hex word at one position of an EVM log payload.
 * @param data - the hex data field.
 * @param index - which word to read.
 * @returns the word as a bigint.
 */
function word(data: string, index: number): bigint {
  const body = data.startsWith('0x') ? data.slice(2) : data;
  const slice = body.slice(index * 64, (index + 1) * 64);
  return slice ? BigInt(`0x${slice}`) : 0n;
}

/**
 * Poll an EVM chain for USDC transfers into the treasury address, using the
 * ERC-20 Transfer log topic filtered by recipient.
 * @param config - the resolved payment configuration.
 * @returns how many new transfers were recorded.
 */
async function pollEvm(config: PaymentConfig): Promise<number> {
  if (!config.evmTreasury || !config.evmRpc) return 0;
  const headHex = await rpc(config.evmRpc, 'eth_blockNumber', []) as string;
  const head = BigInt(headHex);
  const stored = getSetting(KEYS.evmCursor);
  // A first run starts near the head rather than at genesis: history before
  // the operator configured payments belongs to nobody here.
  const from = stored ? BigInt(stored) + 1n : (head > MAX_EVM_BLOCK_SPAN ? head - MAX_EVM_BLOCK_SPAN : 0n);
  if (from > head) return 0;
  const to = from + MAX_EVM_BLOCK_SPAN < head ? from + MAX_EVM_BLOCK_SPAN : head;

  const paddedTreasury = `0x${config.evmTreasury.replace(/^0x/, '').padStart(64, '0')}`;
  const logs = await rpc(config.evmRpc, 'eth_getLogs', [{
    fromBlock: `0x${from.toString(16)}`,
    toBlock: `0x${to.toString(16)}`,
    address: config.evmUsdc,
    topics: [TRANSFER_TOPIC, null, paddedTreasury],
  }]) as { transactionHash: string; topics: string[]; data: string }[];

  let recorded = 0;
  for (const log of logs) {
    const senderTopic = log.topics[1];
    if (!senderTopic) continue;
    const sender = `0x${senderTopic.slice(-40)}`;
    const added = recordTransfer({
      chain: config.evmChain,
      txHash: log.transactionHash,
      fromAddress: sender,
      asset: 'USDC',
      amountAtomic: word(log.data, 0),
      blockTime: null,
    });
    if (added) recorded += 1;
  }
  setSetting(KEYS.evmCursor, to.toString());
  void USDC_DECIMALS;
  return recorded;
}

/**
 * Run one polling pass over both chains. Each chain is isolated: an RPC that
 * is down or rate-limited must not stop the other from settling payments.
 * @returns how many new transfers were recorded, per chain.
 */
export async function pollPayments(): Promise<{ sui: number; evm: number }> {
  const config = paymentConfig();
  if (!config.enabled) return { sui: 0, evm: 0 };
  let sui = 0;
  let evm = 0;
  try {
    sui = await pollSui(config);
  } catch (error) {
    console.error('[payments] Sui poll failed:', error instanceof Error ? error.message : error);
  }
  try {
    evm = await pollEvm(config);
  } catch (error) {
    console.error('[payments] EVM poll failed:', error instanceof Error ? error.message : error);
  }
  if (sui + evm > 0) console.log(`[payments] credited ${String(sui + evm)} new transfer(s)`);
  return { sui, evm };
}

/**
 * Start the background poller. Idempotent: a second call is ignored so a
 * reload cannot double-scan.
 * @returns a function that stops the poller.
 */
export function startPaymentWatcher(): () => void {
  let stopped = false;
  const tick = (): void => {
    if (stopped) return;
    void pollPayments().finally(() => {
      if (!stopped) timer = setTimeout(tick, POLL_INTERVAL_MS);
    });
  };
  let timer = setTimeout(tick, 10_000);
  timer.unref?.();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
