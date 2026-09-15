import { connectNetwork } from '../src/network.js';
/** Create or locate an IMP/CMP portfolio and optionally fund it with AUSD. */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import {
  createWalletClient,
  http,
  type Abi,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const erc20Abi: Abi = [
  {
    type: 'function',
    name: 'transfer',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
];
function load<T>(path: string): T {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')) as T;
}
function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}; copy .env.example to .env`);
  return value;
}
function flag(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
function positive(value: string, name: string): bigint {
  try {
    const n = BigInt(value);
    if (n <= 0n) throw new Error();
    return n;
  } catch {
    throw new Error(`${name} must be a positive integer`);
  }
}

const network = (flag('--network', 'testnet') ?? '').toLowerCase();
if (network !== 'testnet' && network !== 'mainnet')
  throw new Error('--network must be testnet or mainnet');
const rpcUrl = required('RPC_URL');
const { config, chain, publicClient } = await connectNetwork(network, rpcUrl);
const factoryAbi = load<Abi>('../abi/PortfolioFactory.json');
const typeName = (flag('--portfolio-type', 'imp') ?? '').toLowerCase();
if (typeName !== 'imp' && typeName !== 'cmp')
  throw new Error('--portfolio-type must be imp or cmp');
const portfolioType = typeName === 'imp' ? 1 : 2;
const funding = flag('--fund');
const execute = process.argv.includes('--execute');
if (execute && !process.argv.includes('--acknowledge-live-risk'))
  throw new Error('--execute requires --acknowledge-live-risk');
const account = privateKeyToAccount(required('PRIVATE_KEY') as Hex);
const walletClient = createWalletClient({
  chain,
  account,
  transport: http(rpcUrl),
});
if ((await publicClient.getChainId()) !== config.chainId)
  throw new Error(`RPC chain ID does not match ${network}`);

let portfolio = (await publicClient.readContract({
  address: config.contracts.portfolioFactory,
  abi: factoryAbi,
  functionName: 'userPortfolio',
  args: [account.address, portfolioType],
})) as Address;
const none = '0x0000000000000000000000000000000000000000';
if (portfolio === none) {
  const { request } = await publicClient.simulateContract({
    address: config.contracts.portfolioFactory,
    abi: factoryAbi,
    functionName: 'deployPortfolio',
    args: [portfolioType],
    account,
  });
  console.log({
    mode: execute ? 'CREATE_AND_OPTIONALLY_FUND' : 'SIMULATE_ONLY',
    portfolioType: typeName,
    owner: account.address,
    action: 'deployPortfolio',
  });
  if (!execute) {
    console.log(
      'Deployment simulation succeeded. Add --execute --acknowledge-live-risk to create the portfolio.',
    );
    process.exit(0);
  }
  const hash = await walletClient.writeContract({
    ...request,
    nonce: await publicClient.getTransactionCount({
      address: account.address,
      blockTag: 'pending',
    }),
  });
  console.log({ hash });
  const receipt = await publicClient.waitForTransactionReceipt({
    hash,
    timeout: 120_000,
  });
  if (receipt.status !== 'success')
    throw new Error(`Portfolio creation reverted: ${hash}`);
  portfolio = (await publicClient.readContract({
    address: config.contracts.portfolioFactory,
    abi: factoryAbi,
    functionName: 'userPortfolio',
    args: [account.address, portfolioType],
  })) as Address;
  if (portfolio === none)
    throw new Error(
      `Portfolio creation receipt succeeded but ${typeName.toUpperCase()} portfolio was not found`,
    );
  console.log({ createdPortfolio: portfolio, hash });
} else {
  console.log({
    mode: execute ? 'OPTIONALLY_FUND' : 'READ_ONLY',
    portfolioType: typeName,
    portfolio,
  });
}
if (!funding) process.exit(0);
const amount = positive(funding, '--fund');
const beforeBalance = (await publicClient.readContract({
  address: config.contracts.settlementToken,
  abi: erc20Abi,
  functionName: 'balanceOf',
  args: [portfolio],
})) as bigint;
const { request } = await publicClient.simulateContract({
  address: config.contracts.settlementToken,
  abi: erc20Abi,
  functionName: 'transfer',
  args: [portfolio, amount],
  account,
});
console.log({
  action: 'transferAUSD',
  portfolio,
  amount: amount.toString(),
  beforeBalance: beforeBalance.toString(),
  mode: execute ? 'EXECUTE' : 'SIMULATE_ONLY',
});
if (!execute) process.exit(0);
const hash = await walletClient.writeContract({
  ...request,
  nonce: await publicClient.getTransactionCount({
    address: account.address,
    blockTag: 'pending',
  }),
});
console.log({ hash });
const receipt = await publicClient.waitForTransactionReceipt({
  hash,
  timeout: 120_000,
});
if (receipt.status !== 'success')
  throw new Error(`AUSD funding reverted: ${hash}`);
const afterBalance = (await publicClient.readContract({
  address: config.contracts.settlementToken,
  abi: erc20Abi,
  functionName: 'balanceOf',
  args: [portfolio],
})) as bigint;
console.log({
  fundingHash: hash,
  portfolio,
  afterBalance: afterBalance.toString(),
});
