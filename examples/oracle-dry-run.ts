/** Read-only live-chain check: fresh Pyth payload → OracleRouter simulation. */
import 'dotenv/config';
import { flag, positive, required } from '../src/cli.js';
import { connectNetwork } from '../src/network.js';
import { json } from '../src/portfolio.js';
import { freshPayloads } from '../src/transaction.js';

const oracleUpdateAbi = [
  {
    type: 'function',
    name: 'updateAndGetInstPrice',
    stateMutability: 'nonpayable',
    inputs: [
      { name: '_instId', type: 'uint256' },
      { name: '_updateData', type: 'bytes[]' },
    ],
    outputs: [
      { name: 'instPrice', type: 'uint256' },
      { name: 'scale', type: 'uint256' },
    ],
  },
] as const;

const network = flag('--network', 'testnet');
const { config, publicClient } = await connectNetwork(
  network,
  required('RPC_URL'),
);
const instId = positive(flag('--inst-id', '1'));
const instrument = config.instruments[instId.toString()];
if (!instrument) throw new Error('Unknown instrument');
const blockNumber = await publicClient.getBlockNumber();
const { result } = await publicClient.simulateContract({
  address: config.contracts.oracleRouter,
  abi: oracleUpdateAbi,
  functionName: 'updateAndGetInstPrice',
  args: [instId, await freshPayloads(instrument.pythFeedId)],
});
console.log(
  json({
    status: 'SIMULATION_SUCCEEDED',
    network,
    blockNumber,
    instrument: instrument.symbol,
    instPrice: result[0],
    scale: result[1],
  }),
);
