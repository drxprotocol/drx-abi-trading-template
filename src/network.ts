import { readFileSync } from 'node:fs';
import {
  createPublicClient,
  defineChain,
  http,
  isAddress,
  type Address,
  type Hex,
} from 'viem';

export interface NetworkConfig {
  chainId: number;
  networkName: string;
  blockTimeMs: number;
  contracts: {
    trading: Address;
    portfolioFactory: Address;
    oracleRouter: Address;
    settlementToken: Address;
  };
  instruments: Record<string, { symbol: string; pythFeedId: Hex }>;
}

/** Resolve the chain through RPC, then enforce the caller's intended network. */
export async function connectNetwork(expected: string, rpcUrl: string) {
  if (!['mainnet', 'testnet'].includes(expected))
    throw new Error('Network must be mainnet or testnet');
  const probe = createPublicClient({ transport: http(rpcUrl) });
  const chainId = await probe.getChainId();
  const network =
    chainId === 143 ? 'mainnet' : chainId === 10143 ? 'testnet' : undefined;
  if (!network || network !== expected)
    throw new Error('RPC chain does not match selected network');
  const config = JSON.parse(
    readFileSync(new URL(`../config/${network}.json`, import.meta.url), 'utf8'),
  ) as NetworkConfig;
  if (
    config.chainId !== chainId ||
    !Number.isInteger(config.blockTimeMs) ||
    config.blockTimeMs <= 0
  )
    throw new Error('Invalid network configuration');
  for (const key of [
    'trading',
    'portfolioFactory',
    'oracleRouter',
    'settlementToken',
  ] as const) {
    if (!isAddress(config.contracts?.[key]))
      throw new Error(`Invalid contract address: ${key}`);
  }
  if (!config.instruments || !Object.keys(config.instruments).length)
    throw new Error('Missing instruments');
  for (const [id, instrument] of Object.entries(config.instruments)) {
    if (
      !/^[1-9][0-9]*$/.test(id) ||
      !instrument.symbol ||
      !/^0x[0-9a-fA-F]{64}$/.test(instrument.pythFeedId)
    )
      throw new Error('Invalid instrument configuration');
  }
  const chain = defineChain({
    id: chainId,
    name: config.networkName,
    nativeCurrency: { name: 'Monad', symbol: 'MON', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
    blockTime: config.blockTimeMs,
  });
  return {
    config,
    chain,
    // Reconciliation must observe the receipt's state rather than a cached
    // pre-transaction RPC response. Consumers can add their own caching layer.
    publicClient: createPublicClient({
      chain,
      transport: http(rpcUrl),
      cacheTime: 0,
    }),
  };
}
