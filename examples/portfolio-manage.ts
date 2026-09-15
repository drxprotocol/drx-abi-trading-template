/** Owner signing example: leverage, IMP margin adjustment, settlement withdrawal. */
import { context, flag, positive, submit } from '../src/cli.js';
import { abi, json, readPortfolio } from '../src/portfolio.js';
import { freshPayloads, freshSimulation } from '../src/transaction.js';

const ctx = await context();
const { publicClient, config, portfolio, account, type } = ctx;
const action = flag('--action');
if (!['leverage', 'add-margin', 'reduce-margin', 'withdraw'].includes(action))
  throw new Error('Unknown portfolio action');
const instId = positive(flag('--inst-id'));
const instrument = config.instruments[instId.toString()];
if (!instrument) throw new Error('Unknown instrument');
if (type === 'cmp' && ['add-margin', 'reduce-margin'].includes(action))
  throw new Error(
    'CMP uses shared collateral: use prepare-portfolio --fund or withdraw, not per-position margin adjustment',
  );
const amount = positive(
  flag(action === 'leverage' ? '--leverage' : '--amount'),
);
console.log(
  json({
    action,
    before: await readPortfolio(publicClient, config, portfolio, type, instId),
  }),
);
const nonce = await publicClient.getTransactionCount({
  address: account.address,
  blockTag: 'pending',
});
const request =
  action === 'add-margin' || action === 'reduce-margin'
    ? (
        await freshSimulation(
          () => freshPayloads(instrument.pythFeedId),
          (payloads) =>
            publicClient.simulateContract({
              address: config.contracts.trading,
              abi: abi('Trading'),
              functionName:
                action === 'add-margin' ? 'addMargin' : 'reduceMargin',
              args: [portfolio, instId, amount, payloads],
              account,
              nonce,
            }),
        )
      ).request
    : (
        await publicClient.simulateContract({
          address: portfolio,
          abi: abi(
            type === 'imp' ? 'IsolatedMarginPortfolio' : 'CrossMarginPortfolio',
          ),
          functionName: action === 'leverage' ? 'changeLeverage' : 'withdraw',
          args:
            action === 'leverage'
              ? [instId, amount]
              : [config.contracts.settlementToken, amount],
          account,
          nonce,
        })
      ).request;
await submit(ctx, request);
if (ctx.execute)
  console.log(
    json({
      after: await readPortfolio(publicClient, config, portfolio, type, instId),
    }),
  );
