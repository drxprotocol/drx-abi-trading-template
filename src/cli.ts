import 'dotenv/config';
import {
  createWalletClient,
  http,
  isAddress,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { connectNetwork } from './network.js';
import { abi, json } from './portfolio.js';

export function flag(name: string, fallback?: string): string {
  const i = process.argv.indexOf(name);
  const value = i < 0 ? fallback : process.argv[i + 1];
  if (!value || value.startsWith('--')) throw new Error(`Missing ${name}`);
  return value;
}
export function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
export function positive(value: string): bigint {
  if (!/^[0-9]+$/.test(value) || BigInt(value) <= 0n)
    throw new Error('Expected a positive integer in protocol units');
  return BigInt(value);
}
export function portfolioType(): 'imp' | 'cmp' {
  const type = flag('--portfolio-type', 'imp');
  if (type !== 'imp' && type !== 'cmp')
    throw new Error('Portfolio type must be imp or cmp');
  return type;
}
export async function context() {
  const rpcUrl = required('RPC_URL');
  const network = flag('--network', 'testnet');
  const connected = await connectNetwork(network, rpcUrl);
  const type = portfolioType();
  const account = privateKeyToAccount(required('PRIVATE_KEY') as Hex);
  const walletClient = createWalletClient({
    account,
    chain: connected.chain,
    transport: http(rpcUrl, { retryCount: 0 }),
  });
  const execute = process.argv.includes('--execute');
  if (execute && !process.argv.includes('--acknowledge-live-risk'))
    throw new Error('--execute requires --acknowledge-live-risk');
  const portfolio = (await connected.publicClient.readContract({
    address: connected.config.contracts.portfolioFactory,
    abi: abi('PortfolioFactory'),
    functionName: 'userPortfolio',
    args: [account.address, type === 'imp' ? 1 : 2],
  })) as Address;
  if (!isAddress(portfolio) || portfolio === zeroAddress)
    throw new Error('Run prepare-portfolio first');
  return {
    ...connected,
    account,
    walletClient,
    portfolio,
    type,
    execute,
    network,
  };
}
export type Context = Awaited<ReturnType<typeof context>>;
export async function submit(
  ctx: Context,
  request: Awaited<
    ReturnType<Context['publicClient']['simulateContract']>
  >['request'],
) {
  if (!ctx.execute) {
    console.log('Simulation succeeded; no transaction submitted.');
    return;
  }
  const hash = await ctx.walletClient.writeContract(request);
  console.log(json({ hash }));
  try {
    const receipt = await ctx.publicClient.waitForTransactionReceipt({
      hash,
      confirmations: 1,
      timeout: 120_000,
    });
    if (receipt.status !== 'success')
      throw new Error(`Transaction reverted: ${hash}`);
    console.log(json({ hash, blockNumber: receipt.blockNumber }));
    return receipt;
  } catch {
    throw new Error(
      `Receipt unsuccessful or unavailable for ${hash}; reconcile this transaction before retrying. No automatic resubmission.`,
    );
  }
}
