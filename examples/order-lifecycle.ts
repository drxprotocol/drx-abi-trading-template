/** Limit create/modify/cancel or position-aware reduce-only close. */
import { context, flag, positive, submit } from '../src/cli.js';
import { abi, closeOrder, json, readPortfolio } from '../src/portfolio.js';
import { freshPayloads, freshSimulation } from '../src/transaction.js';

const ctx = await context();
const { publicClient, config, portfolio, account, type } = ctx;
const action = flag('--action');
if (!['create-limit', 'modify-limit', 'cancel', 'close'].includes(action))
  throw new Error('Unknown order action');
const instId = positive(flag('--inst-id'));
const instrument = config.instruments[instId.toString()];
if (!instrument) throw new Error('Unknown instrument');
const before = await readPortfolio(
  publicClient,
  config,
  portfolio,
  type,
  instId,
);
console.log(json({ action, before }));
const nonce = await publicClient.getTransactionCount({
  address: account.address,
  blockTag: 'pending',
});
const common = {
  address: config.contracts.trading,
  abi: abi('Trading'),
  account,
  nonce,
};
// The published ABI intentionally includes both historical overloads. Select
// the three-argument variant explicitly when a time-in-force is supplied.
const tifLimitAbi = common.abi.filter(
  (item) =>
    item.type !== 'function' ||
    item.name !== 'createLimitOrder' ||
    item.inputs.length === 3,
);
let request;
if (action === 'cancel' || action === 'modify-limit') {
  const orderId = positive(flag('--order-id'));
  if (!before.pendingOrderIds.includes(orderId))
    throw new Error(
      'Order does not belong to selected portfolio/instrument at snapshot',
    );
  request = (
    await publicClient.simulateContract({
      ...common,
      functionName:
        action === 'cancel' ? 'cancelPendingOrder' : 'modifyLimitOrder',
      args:
        action === 'cancel'
          ? [orderId]
          : [
              {
                orderId,
                newOrderSize: positive(flag('--size')),
                newOrderPrice: positive(flag('--limit-price')),
              },
            ],
    })
  ).request;
} else {
  const core =
    action === 'close'
      ? closeOrder(before.position)
      : (() => {
          const side = flag('--side');
          if (side !== 'long' && side !== 'short')
            throw new Error('Side must be long or short');
          return {
            side: side === 'long' ? 1 : 2,
            size: positive(flag('--size')),
            reduceOnly: process.argv.includes('--reduce-only'),
          };
        })();
  if (
    action === 'close' &&
    (process.argv.includes('--side') || process.argv.includes('--size'))
  )
    throw new Error(
      'Close derives side and full size from the position; omit --side and --size',
    );
  if (action === 'close' && before.pendingOrderIds.length)
    throw new Error('Cancel pending orders for this instrument before closing');
  const tifName = flag('--tif', 'gtc');
  const tif = ['gtc', 'ioc', 'fok'].indexOf(tifName);
  if (tif < 0) throw new Error('Invalid time in force');
  const order =
    action === 'close'
      ? {
          core: { ...core, portfolio, instId },
          slippageLimit: positive(flag('--slippage-limit')),
        }
      : {
          core: { ...core, portfolio, instId },
          limitPrice: positive(flag('--limit-price')),
          postOnly: process.argv.includes('--post-only'),
        };
  request = (
    await freshSimulation(
      () => freshPayloads(instrument.pythFeedId),
      (payloads) =>
        publicClient.simulateContract({
          ...common,
          abi: action === 'close' ? common.abi : tifLimitAbi,
          functionName:
            action === 'close' ? 'executeMarketOrder' : 'createLimitOrder',
          args: action === 'close' ? [order, payloads] : [order, payloads, tif],
        }),
    )
  ).request;
}
await submit(ctx, request);
if (ctx.execute) {
  const after = await readPortfolio(
    publicClient,
    config,
    portfolio,
    type,
    instId,
  );
  console.log(json({ after }));
  if (action === 'close' && after.position.posState === 1)
    throw new Error(
      'Close receipt succeeded but position remains open; inspect remaining size before another trade',
    );
  if (
    action === 'cancel' &&
    after.pendingOrderIds.includes(positive(flag('--order-id')))
  )
    throw new Error('Cancelled order still pending; reconcile before retrying');
}
