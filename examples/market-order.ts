/** Snapshot → fresh oracle payload → simulate → optional submit → reconcile. */
import { context, flag, positive, submit } from '../src/cli.js';
import { abi, json, readPortfolio } from '../src/portfolio.js';
import { freshPayloads, freshSimulation } from '../src/transaction.js';

const ctx = await context();
const { publicClient, config, portfolio, account, type } = ctx;
const instId = positive(flag('--inst-id'));
const instrument = config.instruments[instId.toString()];
if (!instrument) throw new Error('Unknown instrument');
const side = flag('--side');
if (side !== 'long' && side !== 'short')
  throw new Error('Side must be long or short');
const order = {
  core: {
    instId,
    portfolio,
    side: side === 'long' ? 1 : 2,
    size: positive(flag('--size')),
    reduceOnly: process.argv.includes('--reduce-only'),
  },
  slippageLimit: positive(flag('--slippage-limit')),
};
console.log(
  json({
    order,
    before: await readPortfolio(publicClient, config, portfolio, type, instId),
  }),
);
const nonce = await publicClient.getTransactionCount({
  address: account.address,
  blockTag: 'pending',
});
const { request } = await freshSimulation(
  () => freshPayloads(instrument.pythFeedId),
  (payloads) =>
    publicClient.simulateContract({
      address: config.contracts.trading,
      abi: abi('Trading'),
      functionName: 'executeMarketOrder',
      args: [order, payloads],
      account,
      nonce,
    }),
);
await submit(ctx, request);
if (ctx.execute)
  console.log(
    json({
      after: await readPortfolio(publicClient, config, portfolio, type, instId),
    }),
  );
