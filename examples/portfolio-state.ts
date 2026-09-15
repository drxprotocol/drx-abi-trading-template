/** Read one consistent block snapshot without loading a signing key. */
import { isAddress, zeroAddress, type Address } from 'viem';
import { connectNetwork } from '../src/network.js';
import { flag, portfolioType, positive, required } from '../src/cli.js';
import { abi, json, readPortfolio } from '../src/portfolio.js';

const { config, publicClient } = await connectNetwork(
  flag('--network', 'testnet'),
  required('RPC_URL'),
);
const owner = flag('--owner');
if (!isAddress(owner)) throw new Error('Invalid owner address');
const type = portfolioType();
const instId = positive(flag('--inst-id'));
if (!config.instruments[instId.toString()])
  throw new Error('Unknown instrument');
const portfolio = (await publicClient.readContract({
  address: config.contracts.portfolioFactory,
  abi: abi('PortfolioFactory'),
  functionName: 'userPortfolio',
  args: [owner, type === 'imp' ? 1 : 2],
})) as Address;
if (portfolio === zeroAddress) throw new Error('Portfolio does not exist');
console.log(
  json(await readPortfolio(publicClient, config, portfolio, type, instId)),
);
